# Resultados da Fase 3 — antes × depois

Comparação com o [baseline.md](../baseline.md) (2026-09-29, commit `185894f`).
Mesmas regras: cada número tem data e método; o que não foi medido aparece
como **não medido**.

Data: **2026-09-30** · commit da `main`: `29353ac` (PR #50) · arquitetura em
[architecture.md](../architecture.md).

## Código (`npm run measure:code`)

Método: o baseline descreve o script mas não o versionou; este foi
reescrito a partir da descrição e agora está em
[scripts/measure-code.mjs](../../scripts/measure-code.mjs), para a próxima
comparação ser exata. "Teste" = `*.test.ts(x)` e `src/test/`.

| Métrica | Antes | Depois | Meta da Fase 3 |
|---|---|---|---|
| Arquivos em `src/app` com acesso ao banco | 12 | **0** | 0 ✅ |
| Violações de arquitetura (baseline do `dependency-cruiser`) | 24 | **0** | 0, bloqueando o merge ✅ |
| Arquivos de produção com acesso ao banco/Drizzle | 27 | **18** (11 dentro dos módulos) | só `infrastructure/` e `shared/` — **parcial** |
| Lugares que mudam o status do projeto | 3+ | **1** (`drizzle-project-lifecycle.ts`) | 1 ✅ |
| Arquivos de produção / de teste | 121 / 23 | 164 / 51 | — |
| Linhas em `src/app` / `src/components` / `src/lib` | 3.014 / 4.235 / 4.871 | 2.665 / 4.817 / 3.346 | — |
| Linhas em `src/modules` / `src/shared` | — | 2.953 / 299 | — |
| Dependências vulneráveis de produção (`npm audit --omit=dev`) | 0 | 0 | — |

Os 7 arquivos de fora dos módulos com acesso ao banco: `src/db/schema.ts` e
`src/lib/db.ts` (a própria infraestrutura), `src/lib/auth.ts` (adapter do
NextAuth), `src/lib/rate-limit.ts`, `src/lib/files/storage.ts`,
`src/lib/analysis/report.ts` e `src/lib/actions/analysis.ts` (ver
"O que ainda não está nos módulos" em [architecture.md](../architecture.md)).

## Testes

| Tipo | Antes | Depois |
|---|---|---|
| Unitários e de componente | 156 (+1 `it.fails` do TD-31) | **270** (+2 pulados: o teste do modelo real, opt-in) — inclui 17 de componente (jsdom) |
| Integração (Postgres real) | 10 | **89** |
| E2E | 3 | 3 (o fluxo completo agora também compartilha e revoga o link público) |
| Snapshots de caracterização | 0 | análise completa, geração do relatório, prompt do chat |
| Mutações verificadas | — | cada rede nova foi conferida estragando o código de propósito |

Tempos locais (2026-09-30): unitários 4,9 s (inclui o jsdom); integração
16,8 s.

## Comportamento corrigido na Fase 3

- **Análise:** falso positivo `const x = (expr)` (TD-31), `src/test/` como
  testes, segredos em fixtures ignorados. Snapshot com o diff exato.
- **Cota:** falha nossa na importação devolve a análise (TD-12).
- **Segurança:** código do repositório como dado nos prompts (TD-28).
- **Produto:** link público do relatório; filtros de issues na URL.

## Não medido ainda (depende de produção)

| Métrica | Como medir | Quem |
|---|---|---|
| Score do próprio repositório (§2 do baseline: 30/100) | analisar este repositório pelo GitHub em produção e ler `reports` | autor (uma análise) |
| Duração da análise (§1: 20,4 s e 46,0 s) | mesma consulta de leitura do baseline | depois da análise acima |

A expectativa, a confirmar com o número: Code Quality e Testing continuam
baixos, porque a penalidade sem teto é da Fase 7; somem os falsos positivos
do TD-31, de `src/test/` e da fixture de segredo.
