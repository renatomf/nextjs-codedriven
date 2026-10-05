# ADR-012 — Vulnerabilidades de dependências na nota de Security

- **Status:** aceita
- **Data:** 2026-10-05
- **Fase do roadmap:** v2.1 — Calibração das notas (TD-50, item 3)

## Contexto

A nota de Security era uma base fixa (90, ou 70 com segredo no código) menos
os achados do LLM. O LLM vê uma amostra e varia entre execuções (TD-43): no
eval, o mesmo NodeGoat ia de 0 a 24 pontos. Faltava um sinal objetivo, que
não dependesse do modelo.

Medido em 2026-10-05 com o OSV (osv.dev, a mesma base do `osv-scanner` do CI),
só dependências de produção:

| Repositório | Pacotes | Vulneráveis | Avisos (crít./alto/mod./baixo) |
|---|---|---|---|
| NodeGoat | 380 | 40 | 11 / 48 / 20 / 9 |
| Este repositório | 996 | 2 | 0 / 2 / 0 / 0 (os do TD-52, transitivos) |
| Juice Shop | — | — | sem lockfile |

A ingestão guarda só arquivos JS/TS e `package.json`: o lockfile não chega
à análise.

## Problema

Como usar as vulnerabilidades conhecidas das dependências na nota de
Security sem punir demais o que o projeto não controla, e sem expor dados
dos usuários a terceiros?

## Opções consideradas

**Peso das transitivas** (simulado com a penalidade decrescente da ADR-010):

| Opção | Este repositório | NodeGoat |
|---|---|---|
| Peso cheio (como o OSV reporta) | 72 | ~50 |
| **Transitiva um nível abaixo** | **81** | **58** |
| Só diretas | 90 | maior |

- Peso cheio põe este repositório abaixo da meta "saudável > 75" por dois
  avisos sem correção, usados só por ferramentas.
- Só diretas esconde problemas reais em transitivas.

**Onde guardar as dependências:**

1. **Tabela nova** (`project_dependencies`: nome, versão, direta),
   preenchida na ingestão a partir do lockfile.
2. Guardar o lockfile como arquivo do projeto: arquivos de vários MB, e o
   explorer passaria a mostrá-lo.

**Quando consultar o OSV:** na geração do relatório (avisos novos a cada
análise), não na ingestão (ficariam velhos).

## Decisão

- Lockfile npm (v1, v2 e v3) lido na ingestão; só dependências de
  **produção** (as de desenvolvimento não vão para o deploy). Tabela nova.
  O primeiro PR trouxe o domínio, o cliente do OSV e a medição; o segundo,
  a migration, a ingestão, o relatório e a página `/data`. O lockfile é lido
  só na raiz do arquivo (até 10 MB) e nunca é guardado; projetos importados
  antes ficam "não varridos" até a próxima análise.
- Um achado de Security por pacote vulnerável (regra `vulnerable-dependency`),
  com a severidade do pior aviso. **Transitiva pesa um nível abaixo**
  (alta vira média): muitas vezes o código do projeto nem alcança a parte
  vulnerável. Os achados se agrupam e usam a penalidade decrescente da
  ADR-010.
- Sem lockfile, a nota não muda e o relatório diz que as versões são
  desconhecidas. Com o OSV fora do ar (20 s de limite), também não muda, e
  o relatório diz que as dependências não foram checadas.
- **Privacidade:** só pacotes do registro público (`registry.npmjs.org`) vão
  para o OSV. Um pacote de registro privado ou de git revelaria o nome de
  código interno a um terceiro.

**Resultado medido** (eval `2026-10-05-6b7fe3e`, parte determinística): Security
deste repositório 90 → **81**, NodeGoat 90 → **58**, Juice Shop 90 (sem
lockfile). O eval exige NodeGoat abaixo deste repositório quando os dois
forem varridos.

## Trade-offs e consequências

- O OSV vira dependência de runtime do relatório. Falha não derruba o
  relatório, mas a nota daquele relatório fica sem o sinal.
- A lista de dependências públicas de um projeto vai para o Google (OSV).
  Quando o PR seguinte ligar a produção, a página pública `/data` precisa
  dizer isso, ao lado do que vai para o Groq.
- O eval de análise passa a chamar o OSV a cada PR (rede, sem chave, sem
  custo). Se o OSV falhar no CI, o gate de Security fica de fora naquele
  run, sem reprovar.
- Só npm. Yarn e pnpm ficam sem sinal até haver demanda.
- A meta do TD-50 para Security (NodeGoat e Juice Shop abaixo de 40,
  repositório saudável acima de 75, em 3 execuções) junta este sinal com os
  achados do LLM e precisa de cota do Groq: fica para o gate seguinte.
- Revisar se avisos sem correção (como os do TD-52) distorcerem a nota de
  projetos saudáveis.
