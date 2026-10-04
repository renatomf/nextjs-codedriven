# ADR-010 — Fórmula da nota: achados agrupados e penalidade decrescente

- **Status:** aceita
- **Data:** 2026-09-30
- **Fase do roadmap:** 7 — Evals + qualidade da análise

## Contexto

A nota de cada categoria era uma base menos uma penalidade **linear e sem
teto** por achado (crítico 20, alto 12, médio 6, baixo 2). Uma regra que se
repete zerava a categoria sozinha: neste repositório, 8 "Critical area may
lack tests" (8 × 12 = 96) zeravam Testing, e 12 "Complex function" zeravam
Code Quality. O relatório também listava cada repetição como uma linha
separada (22 linhas para 4 problemas). Medido com o eval da Fase 7
([evals/](../../evals/README.md), `2026-09-30-a853a30`).

## Problema

Como uma categoria deve pesar um problema repetido, para que a nota continue
distinguindo "pouco" de "muito" sem que uma única regra a anule?

## Opções consideradas

Simuladas sobre os achados deste repositório (parte determinística):

| Opção | Code Quality | Testing | Nota |
|---|---|---|---|
| Hoje: linear, sem teto | 0 | 0 | 53 |
| A. Teto fixo de 25 pontos por regra | 41 | 9 | 63 |
| **B. Agrupar + penalidade decrescente por grupo** | **42** | **10** | **63** |
| C. Logarítmica (1 + log₂ n) | 11 | 0 | 55 |

- **A** resolve o zero, mas 3 e 30 ocorrências passam a valer o mesmo.
- **C** ainda zera Testing no caso real.
- **B** mantém proporção e é simples de explicar.

## Decisão

Opção B:

1. **Um achado por problema.** Repetições da mesma regra determinística (ou
   achados do LLM com a mesma categoria e o mesmo título) viram um achado
   com a lista de ocorrências, a mais grave primeiro; a severidade do grupo
   é a da ocorrência mais grave (`groupFindings`, `buildReportFindings`).
2. **Penalidade decrescente:** a ocorrência mais grave paga a penalidade
   cheia e cada ocorrência seguinte paga metade da anterior
   (`findingPenalty`). Repetições pesam no máximo 2× uma ocorrência.
   Achados distintos continuam somando normalmente.
3. **Bases por categoria inalteradas;** a nota geral continua a média das
   cinco. `linearPenaltyPolicy` fica no código para o eval comparar.

Resultado medido (`2026-09-30-898f501`): Code Quality 0 → 45, Testing 0 → 10,
nota determinística 53 → 64, 22 → 4 linhas no relatório; precisão e recall
do eval inalterados (o agrupamento não esconde nem inventa achados).

## Trade-offs e consequências

- Dez segredos pesam menos que dez vezes um. Aceito: o primeiro já derruba
  Security (base 70), e cada ocorrência continua listada no relatório.
- Relatórios antigos continuam com o formato antigo (sem `occurrences`); a
  interface mostra os dois. A nota muda só em análises novas.
- O link público redige também título e descrição de cada ocorrência.
- Testing continua baixo neste repositório porque a **heurística** de
  cobertura compara nomes de arquivo; isso é o item 6 da Fase 7, não a
  fórmula.
- Revisar se o eval mostrar que um grupo grande (ex.: dezenas de segredos)
  merece pesar mais que 2×.

## Revisão — base de Testing (2026-10-04, pelo autor)

**Contexto.** Em produção, este repositório (85 arquivos de teste) tirou
Testing **19**, e um repositório **sem nenhum teste** (`dream-v2`) tirou
**28**. Duas causas:

1. A **heurística** não contava os testes que passam pela API pública de um
   módulo e cobrava teste de arquivos sem lógica. Isso foi corrigido no
   TD-31 (PR #132): Testing deste repositório 19 → 30.
2. A **base** `max(40, %)`: 0% de cobertura começava em 40 e 43% em 43, então
   ter testes quase não contava. Um projeto sem testes, com o alerta de
   cobertura baixa (−12), ficava com 28.

**Opções** (números reais: este repositório, ~52% dos arquivos com lógica
testados, com 4 áreas críticas sem teste; `dream-v2`, 0 testes):

| Base de Testing | Este repo | Sem testes |
|---|---|---|
| `max(40, %)` (antes) | 30 | 28 |
| `%` sem piso | 30 | 0 |
| `40 + 0,6 × %` | 49 | 28 |
| **`40 + 0,6 × %`, e 0 sem nenhum arquivo de teste** | **51** | **0** |

**Decisão:** a última. Sem nenhum arquivo de teste, a base é 0: o relatório
diz que não há testes, e a nota não sugere o contrário. Com pelo menos um,
`40 + 0,6 × %`: cada ponto de cobertura conta, e 100% chega a 100.

**Resultado medido** (eval `2026-10-04-5ded353`): Testing deste repositório
19 → **51**, nota determinística 67 → **73**; precisão e recall dos casos
anotados 1,00 / 1,00. `linearPenaltyPolicy` (v1) continua com a base antiga,
para comparação.

**Trade-off:** escrever o primeiro teste salta Testing de 0 para ~29 (com o
alerta de cobertura baixa). Aceito: é a passagem de "não há testes" para "há
testes". Revisar se o eval de repositórios reais mostrar que o salto distorce
a comparação entre projetos pequenos.

### Calibração contra a cobertura medida (2026-10-04)

A heurística estima, sem executar nada, quantos arquivos com lógica os
testes exercitam. Para ter uma referência, a cobertura **real** deste
repositório foi medida (`npm run measure:coverage`: testes unitários e de
integração com v8; o E2E fica de fora): **63%** de statements e **63%** dos
arquivos com funções tiveram alguma função executada (112 de 179). Comparação
arquivo a arquivo com a heurística:

| Alcance a partir dos testes | Estimativa | Concordância | Diz "não testado" e roda | Diz "testado" e não roda |
|---|---|---|---|---|
| Só fachadas (`index.ts` / `server.ts`), #132 | 53% | 91% | 15 | 1 |
| Todos os imports | 66% | 94% | 0 | 11, incluindo `actions/billing.ts`, `auth.config.ts` e `auth.ts` |

Seguir todos os imports estima melhor o percentual, mas marca como testadas
justamente as lacunas reais de auth e billing, que o alerta de áreas
críticas existe para mostrar. **Decisão:** um híbrido. O **percentual** (a
base) segue todos os imports; o **alerta de áreas críticas** segue só as
fachadas. Dois ajustes achados na calibração: um import dentro de uma string
(uma fixture de teste) não conta; um módulo que o próprio teste mocka
(`vi.mock`) não conta.

**Resultado:** estimativa 66% (real 63%); as 4 áreas críticas apontadas
(`actions/auth.ts`, `actions/billing.ts`, `auth.config.ts`, `auth.ts`) são as
4 que nenhum teste executa (precisão e recall 4/4 contra a cobertura); Testing
deste repositório **51 → 57** (eval `2026-10-04-436f928`); casos anotados
1,00 / 1,00. O que falta para chegar perto de 100 é real: testar essas 4 áreas
e as telas (`.tsx`), hoje cobertas só pelo E2E.
