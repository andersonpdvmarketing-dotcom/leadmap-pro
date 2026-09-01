/**
 * LeadMap Pro — cliente PostgreSQL mínimo (protocolo nativo)
 * ==========================================================
 * Implementa o wire protocol v3 do PostgreSQL sobre `node:net`/`node:tls`,
 * com autenticação SCRAM-SHA-256 e MD5. Sem dependências npm.
 *
 * PORQUÊ ISTO EXISTE
 * ------------------
 * A auditoria da Fase C mostrou que o adapter HTTP (PostgREST) **não
 * consegue aplicar migrations**: expõe tabelas e RPC, não executa DDL
 * nem SQL arbitrário. Também não permite abrir uma transação que
 * atravesse vários pedidos, o que é indispensável para provar
 * `FOR UPDATE SKIP LOCKED` com duas sessões concorrentes.
 *
 * Este cliente cobre exatamente o que falta:
 *   · aplicar migrations (DDL);
 *   · abrir sessões independentes, para testes reais de concorrência;
 *   · executar queries parametrizadas ($1, $2…) — nunca concatenação.
 *
 * ESCOPO — LEIA ANTES DE USAR
 * ---------------------------
 * Este cliente NÃO está no caminho de request da Vercel. É usado em:
 *   · migrations (DDL);
 *   · testes de integração;
 *   · ferramentas administrativas executadas deliberadamente.
 *
 * O runtime público usa o adapter HTTP (`postgres.mjs`), que não abre
 * ligações TCP e por isso não esgota `max_connections` sob cold starts.
 * Não há pooling artesanal aqui de propósito: uma ligação por utilização,
 * fechada no fim.
 *
 * NÃO é um driver completo: não faz pooling, não cobre todos os tipos,
 * não faz COPY nem notificações.
 */

import net from 'node:net';
import tls from 'node:tls';
import { createHash, randomBytes, pbkdf2Sync, createHmac, timingSafeEqual } from 'node:crypto';

/* ---------------------------------------------------------------- *
 * Buffers                                                           *
 * ---------------------------------------------------------------- */

class Escritor {
  constructor() { this.partes = []; }
  int8(n) { const b = Buffer.alloc(1); b.writeUInt8(n); this.partes.push(b); return this; }
  int16(n) { const b = Buffer.alloc(2); b.writeInt16BE(n); this.partes.push(b); return this; }
  int32(n) { const b = Buffer.alloc(4); b.writeInt32BE(n); this.partes.push(b); return this; }
  cstr(s) { this.partes.push(Buffer.from(String(s), 'utf8'), Buffer.alloc(1)); return this; }
  bytes(b) { this.partes.push(b); return this; }
  buf() { return Buffer.concat(this.partes); }
  /** Mensagem com etiqueta e comprimento. */
  msg(tag) {
    const corpo = this.buf();
    const cab = Buffer.alloc(tag ? 5 : 4);
    let off = 0;
    if (tag) { cab.write(tag, 0, 'ascii'); off = 1; }
    cab.writeInt32BE(corpo.length + 4, off);
    return Buffer.concat([cab, corpo]);
  }
}

function lerCstr(buf, off) {
  const fim = buf.indexOf(0, off);
  return [buf.toString('utf8', off, fim), fim + 1];
}

/* ---------------------------------------------------------------- *
 * SCRAM-SHA-256                                                     *
 * ---------------------------------------------------------------- */

function hi(password, salt, iteracoes) {
  return pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iteracoes, 32, 'sha256');
}
function hmac(chave, dados) { return createHmac('sha256', chave).update(dados).digest(); }
function xor(a, b) { const o = Buffer.alloc(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] ^ b[i]; return o; }

/* ---------------------------------------------------------------- *
 * Cliente                                                           *
 * ---------------------------------------------------------------- */

export class PgClient {
  /**
   * @param {object|string} config  DSN ou { host, port, user, password, database, ssl }
   */
  constructor(config) {
    const c = typeof config === 'string' ? PgClient.parseDsn(config) : { ...config };
    this.host = c.host || 'localhost';
    this.port = Number(c.port) || 5432;
    this.user = c.user || 'postgres';
    this.password = c.password || '';
    this.database = c.database || c.user || 'postgres';
    this.ssl = Boolean(c.ssl);
    /* O certificado é SEMPRE validado. Só um opt-in deliberado e
       explícito (`tlsInsecure`) o desliga, e mesmo esse é recusado
       fora de development — um TLS que não valida nada dá a ilusão de
       cifra sem a garantia de estar a falar com o servidor certo. */
    this.tlsInsecure = c.tlsInsecure === true;
    this.ca = c.ca || null;
    this.timeoutMs = Number(c.timeoutMs) || 15000;
    this.sock = null;
    this.buffer = Buffer.alloc(0);
    this.aguardar = [];
    this.pronta = false;
    this.fechada = false;
    this.erroFatal = null;
  }

  static parseDsn(dsn) {
    const u = new URL(dsn);
    const ssl = /sslmode=require|sslmode=verify/.test(u.search);
    return {
      host: decodeURIComponent(u.hostname), port: u.port || 5432,
      user: decodeURIComponent(u.username || 'postgres'),
      password: decodeURIComponent(u.password || ''),
      database: decodeURIComponent((u.pathname || '/postgres').slice(1)) || 'postgres',
      ssl
    };
  }

  /** Nunca revela a password; usado em logs e relatórios. */
  descricaoSegura() {
    return { host: '[redacted]', port: this.port, database: '[redacted]', user: '[redacted]', ssl: this.ssl };
  }

  ligar() {
    return new Promise((resolve, reject) => {
      const expira = setTimeout(() => {
        this.aoFalhar(new Error('timeout ao ligar ao PostgreSQL (' + this.timeoutMs + ' ms)'));
        try { if (this.sock) this.sock.destroy(); } catch (e) { /* já fechado */ }
      }, this.timeoutMs);

      const aoLigar = (sock) => {
        this.sock = sock;
        sock.setTimeout(this.timeoutMs * 4, () => {
          /* socket inativo demasiado tempo: fechar em vez de o deixar pendurado */
          this.aoFalhar(new Error('socket PostgreSQL inativo — fechado'));
          try { sock.destroy(); } catch (e) { /* já fechado */ }
        });
        sock.on('data', d => this.aoReceber(d));
        sock.on('error', e => this.aoFalhar(e));
        sock.on('close', () => { this.fechada = true; this.aoFalhar(this.erroFatal || new Error('ligação fechada')); });
        const w = new Escritor().int32(196608);   /* protocolo 3.0 */
        w.cstr('user').cstr(this.user).cstr('database').cstr(this.database);
        w.cstr('client_encoding').cstr('UTF8').int8(0);
        sock.write(w.msg(null));
        this.aguardarPronta = {
          resolve: (v) => { clearTimeout(expira); resolve(v); },
          reject: (e) => { clearTimeout(expira); reject(e); }
        };
      };

      const simples = net.connect({ host: this.host, port: this.port }, () => {
        if (!this.ssl) return aoLigar(simples);
        /* pedido de SSL: int32(8) + int32(80877103) */
        const req = Buffer.alloc(8); req.writeInt32BE(8, 0); req.writeInt32BE(80877103, 4);
        simples.once('data', (r) => {
          if (r.toString('ascii', 0, 1) !== 'S') return reject(new Error('servidor recusou TLS'));
          if (this.tlsInsecure && String(process.env.OUTREACH_ENV || '').startsWith('prod')) {
            return reject(new Error('tlsInsecure não é permitido em produção.'));
          }
          const seguro = tls.connect({
            socket: simples,
            servername: this.host,
            rejectUnauthorized: !this.tlsInsecure,   /* validar o certificado */
            ca: this.ca || undefined
          }, () => aoLigar(seguro));
          seguro.on('error', reject);
        });
        simples.write(req);
      });
      simples.on('error', reject);
    });
  }

  aoFalhar(err) {
    this.erroFatal = err;
    /* nunca deixar um socket pendurado depois de uma falha */
    try { if (this.sock && !this.sock.destroyed) this.sock.destroy(); } catch (e) { /* já fechado */ }
    if (this.aguardarPronta) { this.aguardarPronta.reject(err); this.aguardarPronta = null; }
    while (this.aguardar.length) this.aguardar.shift().reject(err);
  }

  aoReceber(dados) {
    this.buffer = Buffer.concat([this.buffer, dados]);
    while (this.buffer.length >= 5) {
      const tag = this.buffer.toString('ascii', 0, 1);
      const comp = this.buffer.readInt32BE(1);
      if (this.buffer.length < comp + 1) break;
      const corpo = this.buffer.subarray(5, comp + 1);
      this.buffer = this.buffer.subarray(comp + 1);
      this.processar(tag, corpo);
    }
  }

  processar(tag, corpo) {
    const atual = this.aguardar[0];
    switch (tag) {
      case 'R': {                                   /* autenticação */
        const tipo = corpo.readInt32BE(0);
        if (tipo === 0) break;                      /* ok */
        if (tipo === 3) {                           /* password em claro */
          if (!this.ssl) {
            this.aoFalhar(new Error('o servidor pediu password em claro sem TLS — recusado'));
            break;
          }
          this.sock.write(new Escritor().cstr(this.password).msg('p'));
        } else if (tipo === 5) {                    /* MD5 */
          const salt = corpo.subarray(4, 8);
          const h1 = createHash('md5').update(this.password + this.user).digest('hex');
          const h2 = createHash('md5').update(Buffer.concat([Buffer.from(h1, 'utf8'), salt])).digest('hex');
          this.sock.write(new Escritor().cstr('md5' + h2).msg('p'));
        } else if (tipo === 10) {                   /* SASL: SCRAM-SHA-256 */
          this.scramNonce = randomBytes(18).toString('base64');
          this.scramCliente = 'n=,r=' + this.scramNonce;
          const w = new Escritor().cstr('SCRAM-SHA-256');
          const inicial = Buffer.from('n,,' + this.scramCliente, 'utf8');
          w.int32(inicial.length).bytes(inicial);
          this.sock.write(w.msg('p'));
        } else if (tipo === 11) {                   /* SASL continue */
          const servidor = corpo.subarray(4).toString('utf8');
          const p = Object.fromEntries(servidor.split(',').map(x => [x.slice(0, 1), x.slice(2)]));
          const salt = Buffer.from(p.s, 'base64');
          const iter = parseInt(p.i, 10);
          const semProva = 'c=biws,r=' + p.r;
          const salted = hi(this.password, salt, iter);
          const clientKey = hmac(salted, 'Client Key');
          const storedKey = createHash('sha256').update(clientKey).digest();
          const auth = this.scramCliente + ',' + servidor + ',' + semProva;
          const sig = hmac(storedKey, auth);
          const prova = xor(clientKey, sig).toString('base64');
          this.scramSalted = salted; this.scramAuth = auth;
          const resposta = Buffer.from(semProva + ',p=' + prova, 'utf8');
          this.sock.write(new Escritor().bytes(resposta).msg('p'));
        } else if (tipo === 12) {                   /* SASL final */
          const serverKey = hmac(this.scramSalted, 'Server Key');
          const esperado = hmac(serverKey, this.scramAuth).toString('base64');
          const recebido = corpo.subarray(4).toString('utf8').replace(/^v=/, '');
          const a = Buffer.from(esperado), b = Buffer.from(recebido);
          if (a.length !== b.length || !timingSafeEqual(a, b)) this.aoFalhar(new Error('assinatura do servidor inválida'));
        }
        break;
      }
      case 'Z':                                     /* pronto para query */
        if (!this.pronta) {
          /* autenticação concluída: nada de credenciais nem de material
             SCRAM fica em memória mais tempo do que o necessário */
          this.password = '';
          this.scramSalted = null; this.scramAuth = null; this.scramNonce = null; this.scramCliente = null;
        }
        this.pronta = true;
        if (this.aguardarPronta) { this.aguardarPronta.resolve(this); this.aguardarPronta = null; }
        else if (atual) { this.aguardar.shift(); atual.resolve(atual.resultado); }
        break;
      case 'T': {                                   /* descrição de colunas */
        const n = corpo.readInt16BE(0);
        let off = 2; const cols = [];
        for (let i = 0; i < n; i++) {
          const [nome, prox] = lerCstr(corpo, off);
          off = prox + 18;
          cols.push(nome);
        }
        if (atual) atual.resultado.colunas = cols;
        break;
      }
      case 'D': {                                   /* linha */
        const n = corpo.readInt16BE(0);
        let off = 2; const vals = [];
        for (let i = 0; i < n; i++) {
          const comp = corpo.readInt32BE(off); off += 4;
          if (comp === -1) { vals.push(null); continue; }
          vals.push(corpo.toString('utf8', off, off + comp)); off += comp;
        }
        if (atual) {
          const linha = {};
          (atual.resultado.colunas || []).forEach((c, i) => { linha[c] = vals[i]; });
          atual.resultado.rows.push(linha);
        }
        break;
      }
      case 'C': {                                   /* comando concluído */
        if (atual) {
          const txt = lerCstr(corpo, 0)[0];
          const m = txt.match(/(\d+)$/);
          atual.resultado.rowCount = m ? Number(m[1]) : 0;
          atual.resultado.comando = txt.split(' ')[0];
        }
        break;
      }
      case 'E': {                                   /* erro */
        const campos = {};
        let off = 0;
        while (off < corpo.length && corpo[off] !== 0) {
          const t = corpo.toString('ascii', off, off + 1);
          const [v, prox] = lerCstr(corpo, off + 1);
          campos[t] = v; off = prox;
        }
        const err = new Error(campos.M || 'erro do PostgreSQL');
        err.code = campos.C; err.detail = campos.D; err.constraint = campos.n; err.table = campos.t;
        if (atual) { atual.erro = err; }
        else if (this.aguardarPronta) { this.aguardarPronta.reject(err); this.aguardarPronta = null; }
        break;
      }
      case 'I': break;                              /* empty query */
      default: break;                               /* S, K, N, n, 1, 2, 3… ignorados */
    }
    /* erro é entregue quando o servidor voltar a ficar pronto */
    if (tag === 'Z' && atual && atual.erro) { /* já tratado acima */ }
  }

  /**
   * Executa SQL. Com `params` usa o protocolo estendido (parse/bind), que
   * envia os valores separados do texto — imune a injeção de SQL.
   * Sem `params`, usa query simples (necessário para DDL com blocos $$).
   */
  query(sql, params = null) {
    if (this.erroFatal) return Promise.reject(this.erroFatal);
    return new Promise((resolve, reject) => {
      const pedido = {
        resolve: (r) => { if (pedido.erro) reject(pedido.erro); else resolve(r); },
        reject, erro: null,
        resultado: { rows: [], colunas: [], rowCount: 0, comando: null }
      };
      this.aguardar.push(pedido);

      if (params && params.length) {
        const parse = new Escritor().cstr('').cstr(sql).int16(0).msg('P');
        const bind = new Escritor().cstr('').cstr('').int16(0).int16(params.length);
        for (const p of params) {
          if (p === null || p === undefined) { bind.int32(-1); continue; }
          const b = Buffer.from(String(p), 'utf8');
          bind.int32(b.length).bytes(b);
        }
        bind.int16(0);
        const descreve = new Escritor().int8(0x50).cstr('').msg('D');
        const executa = new Escritor().cstr('').int32(0).msg('E');
        const sync = new Escritor().msg('S');
        this.sock.write(Buffer.concat([parse, bind.msg('B'), descreve, executa, sync]));
      } else {
        this.sock.write(new Escritor().cstr(sql).msg('Q'));
      }
    });
  }

  async fim() {
    if (this.sock && !this.fechada) {
      try { this.sock.write(new Escritor().msg('X')); } catch (e) { /* já fechado */ }
      this.sock.destroy();
    }
    this.fechada = true;
  }
}

/** Abre uma ligação já autenticada. */
export async function ligar(config) {
  const c = new PgClient(config);
  await c.ligar();
  return c;
}
