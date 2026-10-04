# ADR-006 — Embeddings em runtime serverless

- **Status:** proposta
- **Data:** 2026-10-04
- **Fase do roadmap:** 5 — Ingestão assíncrona (TD-05, TD-46)

## Contexto

Os embeddings do RAG e da análise vêm de um modelo local
(`Xenova/all-MiniLM-L6-v2`, revisão fixada, `q8`, 384 dimensões) rodando
no `onnxruntime-node`, na CPU, dentro das funções da Vercel (Hobby: 1 vCPU,
2 GB, 300 s por função). O TD-05 temia três coisas desse arranjo:

1. **Tamanho da função** — resolvido pelo TD-41: só o runtime de CPU,
   `analyze`/`flow` de 247,8 → 34–36 MiB.
2. **Cold start e dependência do Hugging Face** — o modelo (~23 MB) é
   baixado no primeiro uso de cada instância. O TD-01 trouxe retry na carga e
   falha que não fica em cache.
3. **Custo de CPU** — o que sobrou, e o maior.

Números de produção (Sentry, spans de 2026-09-27 a 2026-10-04, 10–13
amostras por etapa; tamanhos dos projetos lidos no banco de produção, só
contagens):

| Etapa | p50 | p95 |
|---|---|---|
| `embeddings.embed` | **43,9 s** | 46,6 s |
| `embeddings.model_load` (cold start) | 1,2 s | 1,2 s |
| `vector.replace_chunks` | 0,4 s | 0,7 s |
| `pipeline.chunk` | 0,1 s | 0,1 s |

Projetos reais: mediana de 377 chunks, máximo de 796 (274 arquivos). Com
~44 s para ~350–380 chunks, o embedding custa **~0,12 s por chunk**.

- O TD-03 já zera esse custo quando o código não mudou: reanálise em
  produção com `reused: 344` de 344 (2026-10-03).
- **O risco novo (TD-46):** a importação aceita até 1.000 arquivos
  (`MAX_FILE_COUNT`). Na proporção medida (796 chunks / 274 arquivos) isso
  dá ~2.900 chunks, ~350 s de embedding — acima dos 300 s de um step. O
  step falharia nas três tentativas e a análise terminaria `failed`.
  Estimativa por proporção, não medida; nenhum projeto real passou de 47 s.

## Problema

Onde e como gerar os embeddings para que nenhum projeto aceito pela
importação estoure o tempo de um step, sem mandar o código do usuário a um
terceiro e sem custo?

## Opções consideradas

1. **Manter o modelo local e dividir o embedding em vários steps.** Cada
   step embeda um lote (por exemplo, 800 chunks ≈ 100 s) e guarda os vetores
   por `content_hash`; o step final monta o conhecimento com eles. O TD-03 já
   dá o encaixe: um lote refeito num retry reaproveita o que já foi gravado.
   - Prós: sem fornecedor novo, sem custo, o código não sai do nosso
     controle; o limite passa a ser o número de steps (até 10.000 por run),
     não os 300 s.
   - Contras: os vetores de um lote precisam ficar guardados entre steps
     (uma tabela ou colunas de "pendente" — schema novo); mais steps, mais
     eventos do Workflow (~3 por step, cota do Hobby de 50 mil/mês).
2. **API de embeddings de terceiro** (OpenAI, Voyage, Cohere…).
   - Prós: rápida, sem CPU nossa, sem modelo a baixar.
   - Contras: **o código do usuário sai para um terceiro** (a regra do
     projeto é o contrário: só ids saem, Sentry sem código); custo por
     token; cota e chave novas; trocar o modelo exige re-embedar tudo
     (TD-03 registra o modelo, então dá para saber o que ficou velho).
3. **Empacotar o modelo na função** em vez de baixar no cold start.
   - Prós: tira a dependência do Hugging Face em tempo de execução.
   - Contras: +23 MB nas funções `flow` e `chat` para economizar ~1,2 s;
     não resolve o tempo do embedding, que é o problema.
4. **Baixar o limite de importação** (por exemplo, 500 arquivos).
   - Prós: uma linha.
   - Contras: recusa projetos reais que hoje cabem; esconde o problema.

## Decisão (proposta)

**Opção 1: modelo local na CPU, com o embedding dividido em lotes por step**
(TD-46). O modelo local continua sendo a escolha: o cold start medido é de
1,2 s, o retry do TD-01 cobre falhas do Hugging Face, e o TD-03 já tira o
custo das reanálises. O que precisa mudar é só o embedding de projetos
grandes caber em steps de 300 s.

Antes de implementar, medir de verdade (não por proporção) um projeto perto
do limite no preview: chunks gerados por 1.000 arquivos e duração do
`embeddings.embed`. Se couber em 300 s com folga, o TD-46 fica como risco
monitorado (alerta no Sentry acima de, por exemplo, 200 s) em vez de
mudança de código.

## Trade-offs e consequências

- **Fica igual:** o código do usuário nunca sai para um provedor de
  embeddings; custo zero; um só modelo para a análise e o chat.
- **Obrigatório na implementação:** cada lote idempotente por
  `content_hash` (retry não re-embeda o que já foi gravado); o conhecimento
  só é trocado no fim (a análise anterior continua valendo se um lote
  falhar de vez); só ids entre steps (ADR-005).
- **Revisar se:** o plano sair do Hobby (4 GB / 2 vCPU e 800 s mudam a
  conta); um projeto real passar de 200 s de embedding; ou a qualidade da
  busca pedir um modelo multilíngue (TD-42), que já exigiria re-embedar.
