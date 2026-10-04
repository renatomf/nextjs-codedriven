# Resultados da Fase 6 — antes × depois

Segurança e dados. Início: fechamento da Fase 5 (2026-10-04, commit
`163e67c`, PR #117). Fim: **2026-10-04**, commit da `main` `ab6a523`
(PR #130). Mesmas regras do [baseline.md](baseline.md): cada número tem data
e método; o que não foi medido aparece como **não medido**. Decisão:
[ADR-007](decisions/007-github-app.md) (GitHub App).

## O que mudou no comportamento

| Ponto | Antes | Depois | Como foi verificado |
|---|---|---|---|
| Acesso aos repositórios do GitHub | token OAuth com escopo `repo`: **escrita em todos os repositórios**, sem expiração, guardado cifrado | GitHub App só de leitura (`contents` + `metadata`), nos repositórios que o usuário escolhe; token de **1 h** gerado a cada uso e restrito ao repositório no download; o banco guarda só o id da instalação | spike no preview (#126): escrita com o token → `403`; produção: `renatomf/dream-v2` analisado pelo App, 49 arquivos (2026-10-04, 07:09 UTC) |
| `installation_id` forjado na URL de retorno | — | recusado: só entra se o GitHub o listar entre as instalações do usuário (token do próprio usuário) | teste de rota + mutação; spike: id forjado recusado |
| Login com GitHub | escopo `read:user user:email repo`, token guardado | só `read:user user:email`, token usado em memória e descartado | teste de integração (`recordSignIn` sem token) |
| Tokens antigos guardados | 1 em produção | 0, e a coluna removida | consulta de contagem (sem ler valores) antes e depois das migrações 0012 e 0013 |
| Fluxos de "Connect GitHub" | 2 (Auth.js e OAuth próprio, TD-16) | 1 (GitHub App) | código: rotas antigas removidas (#129) |
| Segredo de criptografia | `ENCRYPTION_KEY` obrigatório | removido (nada mais é cifrado; TD-19 obsoleto) | env da Vercel sem a variável (2026-10-04) |
| Código de projeto sem uso | guardado até o projeto ser apagado | apagado pelo cron após **90 dias** sem uso (projeto e relatório ficam) | integração (11 casos; mutações derrubam 2) |
| Exclusão de conta | não existia | Settings → Delete account: Stripe → uploads → GitHub App → banco | preview: conta apagada, 2 projetos junto, login falha (2026-10-04); integração varre **todas** as tabelas por id, email, customer e projeto e não acha nada |
| O que vai para o Groq | não documentado | página pública `/data`; Zero Data Retention ligado no Groq | componente (números presos às constantes do código); console do Groq (2026-10-04) |
| Content-Security-Policy | só `frame-ancestors` | nonce por request, `Report-Only`, relatórios no Sentry | produção (Playwright, 2026-10-04): `/`, `/login`, `/register`, `/data` com **0** scripts sem nonce e **0** violações |

## Incidentes e tropeços da fase

- **2026-10-04, commit do ZDR fora do merge (#118):** o merge saiu no mesmo
  minuto do push; o commit foi recuperado no #119.
- **2026-10-04, CSP sem nonce em produção (#122 → #124):** o CI passava, a
  Vercel não. Primeira hipótese errada (#123, header da requisição antes do
  proxy). Um log temporário mediu a causa: na Vercel, os headers de resposta
  (o `frame-ancestors` fixo do `next.config.ts`) chegam à renderização, e o
  Next lê o nonce deles. Correção: nenhuma CSP sem o mesmo nonce. Sem
  impacto para usuários (era `Report-Only`).
- **2026-10-04, retorno do GitHub App com 500 no preview:** a rota montava o
  redirecionamento com `AUTH_URL`, que os previews não têm; a instalação já
  tinha sido conferida e gravada. Correção: redirecionar para a origem da
  requisição.
- **CI de arquitetura:** um ciclo `github.ts ↔ github-app.ts` (um `import()`
  dinâmico conta) passou localmente porque o `lint:arch` não foi rodado;
  desde então, a sequência inteira do CI roda antes de cada push.

## Código e testes

| Métrica (`npm run measure:code`) | Início (`163e67c`) | Fim (`ab6a523`) |
|---|---|---|
| Arquivos de produção | 185 | 196 |
| Arquivos de teste | 71 | 79 |
| Arquivos de `src/app` com acesso ao banco | 0 | 0 |
| Arquivos com banco ou Drizzle | 18 | 22 |

Testes no fim (2026-10-04, local): **475 unitários e de componente** (+2
pulados, opt-in; os 10 da criptografia saíram com ela) e **189 de
integração** (Postgres real). No início: 436 e 158 (ver
[results-phase-5.md](results-phase-5.md)). E2E novos: CSP (nonce em todo
script, nenhuma violação no fluxo principal) e redirecionamento das páginas
protegidas.

Migrações da fase: 0010 (`last_used_at`, `code_removed_at`), 0011
(`github_installations`), 0012 (apaga os tokens antigos, só dados), 0013
(remove a coluna, etapa *contract*, aplicada **depois** do deploy do código
que parou de usá-la). Todas aplicadas em `preview` e `main`.

## Não medido

| Métrica | Por quê | Como medir |
|---|---|---|
| Primeira execução da retenção em produção (`codeRemoved`) | os logs da CLI são por deploy e houve vários redeploys no dia | log `projects.reaped` do próximo cron (07:00 UTC); a primeira remoção real só acontece 90 dias depois da migração 0010 |
| Custo de renderizar todas as páginas por request (CSP com nonce) | as páginas públicas eram estáticas; agora geram uma invocação cada | invocações por dia na Vercel, uma semana antes × depois |
| Relatórios de CSP nas páginas logadas em produção | só as públicas foram abertas por automação | Sentry, `environment:production`, alguns dias antes de aplicar a política (TD-34) |
