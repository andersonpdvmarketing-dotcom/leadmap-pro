# DESIGN.md — LeadMap Pro

Sistema visual documentado a partir do build (ground truth: `index.html`). Âmbito: apenas `leadmap-pro/`.

## Tese

Consola de prospeção territorial: **o chrome é tinta monocromática; só os dados vestem cor.** Recusa o template SaaS azul-genérico e os cartões flutuantes de IA. Densidade de ferramenta real (Operate), marca nos detalhes precisos.

## Tokens (fonte de verdade: `:root` / `[data-theme="dark"]` no index.html)

| Papel | Claro | Escuro |
|---|---|---|
| Fundo `--bg` | `#f4f5f7` | `#0d1016` |
| Superfície `--surface` / 2 / 3 | `#fff` / `#f7f8fa` / `#eff1f4` | `#14181f` / `#191e27` / `#1f2530` |
| Hairline `--border` (+ `-strong`) | `#e4e6eb` / `#cbd0d9` | `#262c37` / `#3a424f` |
| Texto `--text` / `-2` / `--muted` / `--faint` | `#171a21` / `#3f4654` / `#5d6675` / `#6b7382` | `#e9ebf0` / `#c4c9d4` / `#9aa3b2` / `#7d8798` |
| **Tinta** `--ink` (ação primária) | `#191d26` | `#e9ebf0` (invertida) |
| Semânticos ok/warn/danger/info | verde/âmbar/vermelho/azul com pares `-bg` | variantes claras sobre tintas escuras |

**Nichos** (a única cor "de marca", pertence aos dados): imobiliário `#2563eb` · saúde `#0d9488` · estética `#db2777` · automóvel `#ea580c` · personalizado `#7c3aed`; cada um com par texto/tint (`--n-*-t`, `--n-*-bg`) e variantes escuras. Sincronizar sempre com `NICHES` no JS. Contraste: todos os pares texto-sobre-tint cumprem ≥4.5:1 (o texto do automóvel é `#9a3412` no claro por isso mesmo); `--faint` foi calibrado para ≥4.5:1 sobre `--surface` nos dois temas — não aclarar.

## Tipografia

- UI: system stack (`--font`); **dados e medidas em `ui-monospace`** (`--mono`, tabular-nums): KPIs, distâncias, códigos postais, telefones, contadores, raio.
- Escala: 22px valores KPI · 15px títulos de modal/marca · 14px base · 13px tabela/botões · 12–12.5px meta/labels · 10.5px cabeçalhos de tabela (uppercase, letter-spacing .07em). Hierarquia por peso/caixa/cor, não por tamanho — densidade deliberada de consola.
- Letter-spacing global -0.006em; títulos -0.01/-0.015em.

## Componentes

- **Botões**: primário = tinta sólida; secundário = superfície + hairline forte; ghost sem borda. Altura 36/30 (sm), radius 8, transições 150ms.
- **KPI strip**: grelha única com divisórias de 1px (gap 1px sobre fundo `--border`) — nunca 6 cartões soltos.
- **Badges de nicho**: pill com ponto colorido + tint de fundo + texto da variante `-t`.
- **Chips de filtro**: pill 28px; ativo herda as cores do nicho via `--chip-*`. Escondem-se quando os resultados têm um único balde — não há nada para filtrar.
- **Campo de pesquisa universal** (`.query-grande`) + **sugestões rápidas** (`.sugestoes`): o campo de texto livre é o primeiro elemento do modal e a entrada principal da app; as sugestões são pills 30px monocromáticas que só preenchem o campo (`aria-pressed` marca a correspondência). Nunca são categorias obrigatórias.
- **Tabela**: thead sticky, hover em `--surface-2`, selecionado com 5% de tinta; `N/D` sempre em `--faint`; entrada de linhas com stagger (cap 24 × 14ms).
- **Modais**: backdrop blur 3px, radius 14; validação = borda/ tint `--danger` + mensagem com ícone alert + `aria-invalid`/`role="alert"`; válido = borda esverdeada.
- **Toasts**: canto inferior direito, ícone semântico, slide-in 220ms.
- **Mapa**: círculo de raio tracejado `5 6` em cinza-tinta; centro = crosshair CSS (`.center-x`); marcadores circleMarker r7 com contorno branco; tiles em dark via filtro `invert+hue-rotate`; popups e controlos Leaflet re-tematizados com tokens.
- **Ícones**: sprite SVG próprio, stroke 1.75, round caps — nunca emoji/unicode como ícone.

## Movimento

Um momento autoral: a **chegada dos resultados** (stagger de linhas + count-up dos KPIs + fitBounds animado do Leaflet). Resto = micro-transições 150ms. `prefers-reduced-motion` desliga tudo.

## Superfícies do browser

`::selection` em tinta, caret em tinta, scrollbars finas tematizadas, `focus-visible` com anel `--ring`, tabular-nums em todos os números.

## Regras ao estender

1. Cor nova = dado novo (nicho/estado); o chrome permanece tinta.
2. Todo o texto UI em PT-PT; erros nomeiam o problema e a correção.
3. Campos vazios mostram literalmente `N/D` (classe `.nd`).
4. Testar sempre nos dois temas e a 375px (sem scroll horizontal da página; tabelas com scroll próprio).
