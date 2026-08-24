# LeadMap Pro — Mapa Inteligente de Leads B2B

Ferramenta de prospeção comercial B2B para Portugal: define uma **localização + raio + nicho**, recebe **leads empresariais com contactos públicos**, visualiza-os no **mapa** e exporta para **Excel (.xlsx)**.

- **Ficheiro único**: `index.html` auto-contido (CSS + JS embutidos; Leaflet e SheetJS via CDN).
- **Sem API keys no frontend** — funciona logo à partida com fontes gratuitas (OpenStreetMap).
- **Arquitetura preparada para Google Maps Platform** (mapa + Places + Geocoding) via proxy.
- UI 100 % em português, tema claro/escuro persistente, responsivo (desktop prioritário).

---

## 1. Abrir localmente

A app precisa de ser servida por **HTTP** para fazer pesquisas reais (os browsers bloqueiam `fetch` em `file://`; nesse modo a app deteta-o, mostra um aviso e entra automaticamente em **modo demonstração**).

Qualquer uma destas opções serve:

```bash
# Python (macOS/Linux já trazem)
cd leadmap-pro
python3 -m http.server 8080
# → abrir http://localhost:8080
```

```bash
# Node
npx serve leadmap-pro
```

Ou no VS Code: extensão **Live Server** → "Open with Live Server".

> Abrir o ficheiro com duplo clique (`file://…/index.html`) também funciona, mas **apenas em modo demo** — o banner amarelo no topo explica-o.

## 2. Fazer deploy (aceder pela internet)

O projeto é 100 % estático — qualquer host serve.

**Netlify (mais rápido):**
1. Ir a [app.netlify.com/drop](https://app.netlify.com/drop)
2. Arrastar a pasta `leadmap-pro` para a página
3. Fica online num URL `https://<nome>.netlify.app` em segundos

**Vercel:**
```bash
npm i -g vercel
cd leadmap-pro
vercel --prod
```

**GitHub Pages:** commit da pasta num repositório → Settings → Pages → Deploy from branch → escolher a pasta. O `index.html` fica servido em `https://<user>.github.io/<repo>/`.

**Cloudflare Pages:** criar projeto → upload direto da pasta.

Não há build, variáveis nem configuração — só o upload.

## 3. Como usar

1. **+ Nova Pesquisa** → morada/código postal/cidade, raio (5–50 km ou personalizado 1–100) e nichos:
   - **Imobiliário** (mediação, consultores, gestão)
   - **Saúde / Odontologia** (clínicas dentárias, implantologia, ortodontia)
   - **Estética** (clínicas de estética, medicina estética, spa, laser)
   - **Automóvel** (stands, concessionários, seminovos)
   - **Personalizado** — qualquer palavra-chave (mín. 3 caracteres)
2. A **pesquisa rápida** na barra superior pesquisa por palavra-chave dentro do território atual (mín. 2 caracteres).
3. Resultados na **tabela** (ordenar por colunas, filtrar por texto/nicho/telefone/website) e no **mapa** (marcadores coloridos por nicho; popup com contactos + "Abrir no Google Maps" + "Ver no Google Earth").
4. Selecionar leads → **Exportar seleção**; sem seleção, o botão **Exportar para Excel** pergunta se quer todos os filtrados.
5. O **histórico** (últimas 20 pesquisas) fica em `localStorage` e permite repetir com um clique.

## 4. Fontes de dados e limitações

| Função | Fonte ativa | Alternativa preparada |
|---|---|---|
| Geocodificação | Nominatim (OSM), fallback Photon | Google Geocoding API (via proxy) |
| Empresas/POIs | Overpass API (4 endpoints com fallback) | Google Places API (via proxy) |
| Mapa | Leaflet + tiles OpenStreetMap | Google Maps JavaScript API |

**Limitações honestas das fontes gratuitas** — importam para expectativas de prospeção:

- O OpenStreetMap só tem as empresas que a comunidade mapeou; a cobertura varia por zona e **muitos registos não têm telefone/website** (a app mostra `N/D`, nunca inventa).
- POIs sem nome são descartados (não são leads utilizáveis).
- O Nominatim tem política de uso justo (~1 pedido/segundo) — a app faz apenas 1 pedido por pesquisa.
- Endpoints Overpass públicos podem estar lentos/sobrecarregados; a app tenta 4 em cadeia e explica o erro se todos falharem.
- Resultados limitados aos **500 mais próximos** (aviso quando truncado).
- Cada lead indica sempre a **fonte** e a **data da pesquisa**; os dados OSM estão sob licença [ODbL](https://www.openstreetmap.org/copyright) (mantenha a atribuição).

**Conformidade (RGPD):** a app usa apenas dados **empresariais públicos** (nome, morada, contactos comerciais publicados), não recolhe dados pessoais privados, não faz scraping contra termos de serviço e identifica a fonte de cada registo. Confirme os contactos antes de campanhas e respeite as regras de comunicações comerciais B2B.

## 5. Estratégia de limpeza de dados (implementada em `DataCleaner`)

Aplicada a **todos** os leads — reais e de demonstração — antes de aparecerem:

1. **Nomes** — colapso de espaços, remoção de carateres de controlo, normalização de travessões; *Title Case* com partículas portuguesas (`de, da, dos…`) apenas quando o nome vem todo em MAIÚSCULAS/minúsculas (preserva marcas como "RE/MAX").
2. **Telefones** — remove espaços/hífenes/parênteses, normaliza `00351`/`351`/`+351`, valida padrão português (9 dígitos, início 2/3/9) e formata `+351 XXX XXX XXX`; classifica **telemóvel** (9x) vs **fixo**; número estrangeiro/ilegível mantém o original.
3. **Websites** — adiciona `https://` em falta, valida o domínio, minúsculas no host, remove barra final.
4. **Códigos postais** — normaliza para `0000-000` (aceita "1685 031", "1685031", etc.).
5. **Moradas** — remove localidade duplicada no fim e espaços excedentes.
6. **Duplicados** — união por: mesmo telefone · mesmo domínio de website · nome ~88 % semelhante (Levenshtein normalizado) a <500 m ou com o mesmo código postal. Vence o registo **mais completo**; os campos em falta são preenchidos pelo outro. O toast da pesquisa indica quantos duplicados foram unidos.
7. **Campos vazios** — `null`, `undefined`, `""`, `"null"`, `"undefined"`, `-` → **`N/D`** (exatamente como especificado; também na exportação).
8. **Distância** — Haversine ao ponto central, arredondada a 1 casa decimal.

## 6. Validação de formulários

Em tempo real (blur + input) e no submit, com mensagens em português, `aria-invalid`/`aria-describedby`/`role="alert"`, borda vermelha em erro e verde em campo válido:

- **Morada/Localidade**: obrigatória, mín. 3 caracteres
- **Código Postal**: vazio ou `0000-000`
- **Cidade**: vazia ou mín. 2 caracteres
- **Raio**: presets 5/10/20/30/50 ou personalizado 1–100 km
- **Nichos**: pelo menos um; **Personalizado** obriga a palavra-chave (mín. 3)
- **Pesquisa rápida**: mín. 2 caracteres

A geocodificação só corre se a localização tiver sido alterada (senão reutiliza as coordenadas atuais).

## 7. Ativar Google Maps Platform (passo a passo)

A arquitetura já tem os pontos de troca prontos (`MapProviders.google`, `PlacesProviders.google`); falta apenas a tua conta Google e o proxy. **A API key nunca vai para o frontend.**

1. **Google Cloud Console** ([console.cloud.google.com](https://console.cloud.google.com)) → criar projeto.
2. **Billing** → associar cartão (obrigatório; a Google inclui crédito mensal gratuito — confirma os valores atuais na página de preços, e define alertas de orçamento).
3. **APIs & Services → Library** → ativar:
   - *Maps JavaScript API* (mapa)
   - *Places API (New)* (Nearby Search / Text Search / Place Details — leads mais ricos)
   - *Geocoding API* (alternativa ao Nominatim)
4. **Credentials → Create API key**. Restringir já:
   - *Application restrictions*: HTTP referrers com o(s) teu(s) domínio(s)
   - *API restrictions*: apenas as 3 APIs acima
5. **Proxy** (protege a key): copiar `google-proxy.example.js` para `google-proxy.js` e correr:
   ```bash
   cd leadmap-pro
   npm init -y && npm i express
   GOOGLE_MAPS_API_KEY="A_TUA_KEY" node google-proxy.js
   # → serve a app em http://localhost:3333 e os endpoints /api/google/*
   ```
   Em produção, o mesmo ficheiro adapta-se a uma serverless function (Netlify/Vercel) — as env vars `GOOGLE_MAPS_API_KEY` / `GOOGLE_PLACES_API_KEY` configuram-se no painel do host.
6. **Ligar no frontend** (`index.html` → `CONFIG`):
   ```js
   mapProvider: 'google',     // mapa Google (ver comentários em MapProviders.google)
   placesProvider: 'google',  // leads via Places (ver PlacesProviders.google)
   google: { enabled: true, proxyBaseUrl: '/api/google' }
   ```
   Os blocos `MapProviders.google` e `PlacesProviders.google` têm a implementação de referência comentada no próprio código.

O toggle "Provedor de mapa" na UI mostra o estado; enquanto `google.enabled` for `false`, clicar em "Google Maps" explica o que falta.

## 8. Google Earth (nota de exploração)

O **Google Earth não é uma API de pesquisa de empresas** — é apenas visualização 3D. A app usa-o do único modo suportado: links diretos `https://earth.google.com/web/@lat,lon,…` no popup de cada marcador e na coluna Ações da tabela ("Ver no Google Earth"). Útil para avaliar visualmente a envolvente de um lead (fachada, zona, acessos) antes do contacto.

## 9. Dados de demonstração

O conjunto embutido (~30 empresas na zona Caneças/Odivelas/Loures/Amadora) é **totalmente fictício**: nomes inventados, telefones em séries `000` e websites no TLD reservado `.example` (nunca resolvem). Serve para explorar a UI offline/`file://` e para demonstrar o pipeline de limpeza — alguns registos vêm propositadamente "sujos" (maiúsculas, CP sem hífen, URLs com barra final, um duplicado que é unido). A fonte aparece sempre como **"Demonstração (dados fictícios)"** com banner informativo.

## 10. Estrutura e manutenção

```
leadmap-pro/
├── index.html               # app completa (CSS + JS embutidos)
├── google-proxy.example.js  # proxy Express opcional p/ Google APIs
└── README.md
```

Dentro do `index.html`, o JS está organizado por secções numeradas: CONFIG → utilitários → DataCleaner → Validator → MapProviders/PlacesProviders → dados demo → pesquisa → renderização → exportação → histórico → UI → arranque. No browser, `window.LeadMapPro` expõe o estado e os módulos para depuração.

**Sistema visual** (para futuras alterações): chrome monocromático "tinta" (`--ink`), cor reservada aos dados — nichos azul/teal/rosa/laranja/violeta (`--n-*`), `ui-monospace` para medidas (distâncias, CP, telefones, contadores), ícones SVG stroke 1.75, hairlines `--border`, temas claro/escuro por tokens em `:root` / `[data-theme="dark"]`.
