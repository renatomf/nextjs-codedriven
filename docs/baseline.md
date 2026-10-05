# Baseline — o "antes" medido

Medições de referência para comparar com as fases seguintes do
[roadmap-v2.md](roadmap-v2.md). Regra: cada número tem data e método; o que
não foi medido aparece como **não medido**, nunca como estimativa.

Data: **2026-09-29** · commit da `main`: `185894f` · arquitetura descrita em
[architecture-baseline.md](architecture-baseline.md). Resultados da Fase 3 em
[results/phase-3.md](results/phase-3.md).

## 1. Duração da análise em produção

Método: diferença entre `projects.created_at` (upload/importação) e
`reports.created_at` (relatório gravado) no banco de produção, para os
projetos analisados depois do conserto da análise na Vercel (PR #7). Inclui
importação, chunking, embeddings, métricas, chamada ao LLM e gravação.
Ambiente: Vercel Hobby (`maxDuration` 300 s), embeddings locais (MiniLM q8).

| Projeto | Origem | Arquivos | Chunks | Tempo até o relatório |
|---|---|---|---|---|
| Amostra (ZIP de `src/lib` deste repo) | upload | 53 | 170 | **20,4 s** |
| Este repositório | GitHub | 146 | 411 | **46,0 s** |

Leitura: 0,11–0,12 s por chunk nas duas amostras (tempo quase proporcional
ao número de chunks), o que sugere tempo dominado pelos embeddings em CPU —
hipótese a confirmar com tempo por etapa (Fase 4). **Amostra de 2 execuções**: suficiente como
referência de ordem de grandeza, não para percentis. Não inclui o cold start
separado (não medido, ver §5).

## 2. Score do próprio repositório

Análise do próprio repositório (importado do GitHub), relatório de
2026-09-29 15:35 UTC:

| Categoria | Score |
|---|---|
| Arquitetura | 70 |
| Segurança | 16 |
| Performance | 66 |
| Code Quality | **0** |
| Testing | **0** |
| **Health score** | **30** |

35 achados. Distribuição do que derruba o score:

- **Testing 0, com 169 testes no repositório** (156 unitários, 10 de
  integração, 3 E2E). A métrica compara nomes de arquivo: 8 achados
  "Critical area may lack tests" (high) só porque o caminho contém `auth`,
  inclusive para `oauth-icons.tsx`; mais "Low test file coverage signal".
  Penalidade linear sem teto (`scoreFromIssues`).
- **Code Quality 0:** 12 "funções complexas" — 9 componentes React medidos
  por número de linhas de JSX, 2 route handlers (`POST` do chat e da
  análise) e 1 falso positivo da regex (`categoryScores`, 262 linhas —
  TD-31); mais 1 "arquivo grande" (`src/app/page.tsx`, landing).
- **Segurança 16:** 1 achado **critical** falso positivo: "hardcoded secret"
  em `src/test/integration/factories.ts`, que gera um texto de teste
  (`export const secret = "…"`); a heurística não reconhece `src/test/` como
  pasta de testes. Os demais achados de segurança do LLM são plausíveis
  (CSP limitada — TD-34, `bodySizeLimit` de 110 MB, cabeçalhos).
- `.claude/` **não** contribuiu: a extração já respeita o `.gitignore` do
  repositório analisado.

Referência anterior (baseline do tutorial, mesmo repo, antes da Fase 2):
**41/100**, com Code Quality 0 e Testing 0 pelas mesmas causas.

## 3. Testes

| Tipo | Início da v2 (tag `v1-tutorial`) | Hoje |
|---|---|---|
| Unitários | 43 casos (7 arquivos) | 156 (+1 `it.fails` documentando o TD-31) |
| Integração (Postgres real) | 0 | 10 |
| E2E | 2 (landing) | 3 (landing + fluxo completo) |
| CI | nenhum | 4 checks obrigatórios para merge |

Tempos (2026-09-29): suíte unitária 1,7 s (local); no CI, integração 3 s
(+13 s do container) e E2E 11 s (+26 s de build, +22 s de instalação do
Chromium).

## 4. Código

| Métrica | Valor |
|---|---|
| Arquivos de produção / de teste | 121 / 23 |
| Linhas em `src/app` / `src/components` / `src/lib` | 3.014 / 4.235 / 4.871 |
| Arquivos em `src/app` com acesso direto ao banco | **12** (6 pages, 6 rotas) |
| Arquivos com acesso direto ao Drizzle (total) | 27 |
| Dependências vulneráveis de produção (npm audit / OSV) | 0 (4 moderadas só em dev, via `drizzle-kit`) |

## 5. Não medido (e como medir)

| Métrica | Por que falta | Quando / como |
|---|---|---|
| Tokens e custo por relatório/chat | nenhum registro de uso do LLM | Instrumentado (Fase 4): tabela `llm_calls`, agregar por `feature` (p50/p95 de tokens, soma de `cost_micro_usd`) |
| Latência do chat (p50/p95) | Vercel não registra duração; sem instrumentação | Instrumentado (Fase 4): `llm_calls.latency_ms` com `feature = 'chat'` e o trace `POST /api/chat` no Sentry; depois 20 perguntas fixas em 3 repos |
| Cold start (download do modelo, 23 MB) | idem | Instrumentado (Fase 4): span `embeddings.model_load` no Sentry |
| Tempo por etapa do pipeline | só existe o total (§1) | Instrumentado (Fase 4): spans `pipeline.load_files`, `pipeline.chunk`, `embeddings.embed`, `vector.replace_chunks`, `report.metrics`, `report.llm_review` |
| Precisão/recall dos achados | não há dataset rotulado | Fase 7 (evals) |
| Qualidade da busca (recall@k) | idem | Fase 7 (evals) |

## Como repetir

- **§1:** consulta de leitura no banco (sem dados sensíveis):
  `SELECT p.file_count, count(c), r.created_at - p.created_at FROM projects p
  JOIN reports r … LEFT JOIN code_chunks c …` para os projetos do período.
- **§2:** analisar este repositório pelo GitHub em produção e ler
  `reports.category_scores` e `reports.issues`.
- **§3/§4:** `npx vitest run`, `npm run test:integration`,
  `npx playwright test`; contagem de imports com um script que percorre
  `src/` procurando `from "@/lib/db"` etc.
