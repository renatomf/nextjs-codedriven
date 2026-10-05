# ADR-013 — Nota de Architecture pelo grafo de imports

- **Status:** aceita
- **Data:** 2026-10-05
- **Fase do roadmap:** v2.1 — Calibração das notas (TD-50, item 5)

## Contexto

A nota de Architecture era uma base fixa (88) menos os achados do LLM: nem
sem achados passava de 88, e nada determinístico olhava a estrutura. A
análise já monta o grafo de imports do projeto (para estimar o alcance dos
testes, ADR-010).

Medido em 2026-10-05 com o `dependency-cruiser` (já usado no CI deste
repositório, regra `no-circular`) como referência:

| Repositório | Módulos | Em ciclos de import | Maior fan-out (não fachada) |
|---|---|---|---|
| Este | 204 | 0 | 12 |
| NodeGoat | 32 | 0 | 9 |
| Juice Shop | 401 | 21 (5%) | 91 (`server.ts`), depois 44 e 30 |

## Problema

Que sinal objetivo do grafo de imports serve de base para Architecture, e
com que limiares?

## Opções consideradas

1. **Base medida pelo grafo**, menos os achados do LLM, como em Code
   Quality.
2. Ciclos e arquivos "deus" só como achados, com a base 88 fixa: menos
   mudança, mas a nota continua sem calibração.
3. Tirar Architecture da nota geral, como Performance, até haver mais
   repositórios de referência.

## Decisão

Opção 1 (escolhida pelo autor):

- **Base = 100 − 4 × % de módulos em ciclos − 4 × % de hubs.** Hub é um
  arquivo que importa mais de **20** módulos do projeto (`HIGH_FAN_OUT`) para
  usá-los. Fica de fora a fachada que só reexporta: um arquivo cujos imports
  são, na maioria, `export … from` (a API pública de um módulo, como os
  `index.ts` daqui). O critério é pelo conteúdo, não pelo nome: o
  `server.ts` do Juice Shop tem nome de fachada, mas importa 90 módulos para
  usá-los. O peso 4 é o mesmo de Code Quality.
- Ciclos (componentes fortemente conexos, Tarjan) e hubs viram achados de
  Architecture (`import-cycle`, `high-fan-out`), listados mas **não cobrados
  de novo**, porque já estão na base. Achados do LLM continuam descontando.
- Só imports entre arquivos do projeto (relativos e `@/`); pacotes ficam de
  fora.

**Resultado medido** (eval de análise, parte determinística): este
repositório 88 → **100**, NodeGoat 88 → **100**, Juice Shop 88 → **73**. O
detector bate com o `dependency-cruiser`: 21 módulos em ciclo no Juice Shop
nos dois, e `server.ts` com 90 contra 91. O eval exige o Juice Shop abaixo
deste repositório.

## Trade-offs e consequências

- O NodeGoat tira 100: é pequeno e plano. Ser inseguro não é ter
  arquitetura ruim; Security é que separa os dois.
- Três repositórios são pouca referência, e só um deles tem problema de
  grafo. O limiar 20 e o peso 4 são escolhas explicadas, não estimadas.
  Revisar com mais repositórios.
- Aliases além de `@/` (outros `paths` do tsconfig) não são resolvidos: um
  projeto que os usa pode ter ciclos não vistos.
- A nota de Architecture deste repositório em produção passa a ser 100
  menos os achados do LLM, em vez de 88 menos os achados.
