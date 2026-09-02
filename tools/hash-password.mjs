#!/usr/bin/env node
/**
 * LeadMap Pro — gerar o hash da password do operador
 * ==================================================
 *   node tools/hash-password.mjs
 *
 * Lê a password do stdin **sem a mostrar** e imprime só o hash scrypt,
 * para colar em `OUTREACH_OPERATOR_PASSWORD_HASH`.
 *
 * A password não é escrita em lado nenhum: nem em ficheiro, nem em log,
 * nem no histórico da shell — por isso não há opção para a passar por
 * argumento. `node tools/hash-password.mjs minhapass` ficaria no
 * `~/.zsh_history` e na lista de processos da máquina.
 *
 * Isto é uma ferramenta administrativa. Não faz parte do runtime e não
 * é servida pela Vercel.
 */

import { createInterface } from 'node:readline';
import { criarHashPassword, verificarPassword } from '../providers/outreach/auth.mjs';

function perguntarEmSilencio(pergunta) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const saida = process.stdout;
    const escreverOriginal = saida.write.bind(saida);
    let mudo = false;
    /* enquanto o utilizador escreve, nada é ecoado */
    saida.write = (chunk, ...resto) => (mudo ? true : escreverOriginal(chunk, ...resto));
    escreverOriginal(pergunta);
    mudo = true;
    rl.question('', (resposta) => {
      mudo = false;
      escreverOriginal('\n');
      saida.write = escreverOriginal;
      rl.close();
      resolve(resposta);
    });
  });
}

const MIN = 12;

const pass = await perguntarEmSilencio('Password do operador (não aparece no ecrã): ');
if (!pass || pass.length < MIN) {
  console.error('A password tem de ter pelo menos ' + MIN + ' caracteres. Nada foi gerado.');
  process.exit(1);
}
const confirmacao = await perguntarEmSilencio('Repita a password: ');
if (pass !== confirmacao) {
  console.error('As passwords não coincidem. Nada foi gerado.');
  process.exit(1);
}

const hash = criarHashPassword(pass);

/* prova de que o hash serve, antes de o entregar */
if (!verificarPassword(pass, hash)) {
  console.error('O hash gerado não verifica a própria password. Não use este valor.');
  process.exit(1);
}

console.log('');
console.log('OUTREACH_OPERATOR_PASSWORD_HASH=' + hash);
console.log('');
console.log('Cole este valor na Vercel (Environment Variables, marcado como secret)');
console.log('ou em .env.local. A password em claro não foi guardada em lado nenhum.');
