# Postmortem — A análise nunca funcionou em produção (ONNX na Vercel)

- **Data do incidente:** do primeiro deploy na Vercel (v1, até 2026-09-28) a
  2026-09-29 (PR #7); recaída de tamanho de 2026-10-02 (PR #89) a 2026-10-03
  (PR #91)
- **Severidade:** a funcionalidade principal (analisar um projeto) falhava
  em produção
- **Autor:** Renato Marques

## Resumo

Desde o primeiro deploy, toda análise em produção falhava ao gerar os
embeddings: a biblioteca nativa do ONNX Runtime não estava dentro da função
da Vercel. Local e no CI tudo funcionava, porque lá o `node_modules` existe
inteiro; só o deploy empacota cada função pelo que o Next consegue rastrear.
Corrigido o empacotamento, a mesma causa voltou de outra forma três dias
depois: as funções estavam a 2 MiB do limite de 250 MiB.

## Linha do tempo

| Quando | O que aconteceu |
|---|---|
| até 2026-09-28 | Primeiro deploy da v1 na Vercel. A análise falha em produção desde o início. |
| até 2026-09-29 | Ao migrar a biblioteca de embeddings (TD-35), vejo o erro em produção: `libonnxruntime.so.1.14.0: cannot open shared object file`. |
| 2026-09-29 | Primeira correção: incluir os binários Linux x64 por rota. O deploy quebra com `exceeded_serverless_functions_per_deployment` (o Hobby permite 12 funções). |
| 2026-09-29 | Include global, excluindo o que nunca roda na Vercel (trace do `analyze`: 228 → 110 MB); depois, só nas rotas `analyze` e `chat`; depois, também o pacote `onnxruntime-node`. Cache do modelo em `/tmp`. Análise funcionando em produção (PR #7). |
| 2026-10-02 | No spike do ADR-005, o `vercel inspect` mede `analyze` com 247,8 MiB e `chat` com 243,9 MiB, contra 250 MiB. A função do workflow sai com 250,02 MiB (PR #89, TD-41). |
| 2026-10-02 | Primeira hipótese, `sharp`, é descartada: só 17,8 MiB. A medição por pacote no CI (PR #90) mostra os providers de GPU. |
| 2026-10-03 | Só o runtime de CPU vai para as funções: `analyze` 34,1 MiB, `chat` 30,4 MiB (PR #91). Gate de 200 MiB no build (PR #93). |
| 2026-10-03 | O download dos providers de GPU derruba um `npm ci` no CI; `ONNXRUNTIME_NODE_INSTALL=skip` no CI e na Vercel (PR #105). |

## Causa raiz

O modelo de embeddings roda com o ONNX Runtime dentro da função serverless.
A Vercel monta cada função com o file tracing do Next, que segue os
`import` e `require` estáticos. Três coisas ficaram fora dele:

1. O binding `.node` carrega a biblioteca nativa por `dlopen`, que o tracing
   não enxerga.
2. O `@huggingface/transformers` carrega o pacote `onnxruntime-node` por um
   `require` dinâmico, que o tracing também não enxerga.
3. O cache do modelo ficava dentro de `node_modules`; na Vercel só `/tmp`
   aceita escrita.

A recaída teve a mesma origem: o empacotamento precisou ser declarado à mão,
e eu incluí a pasta `linux/x64` inteira. O postinstall do `onnxruntime-node`
baixa nela os providers de CUDA e TensorRT (~258 MiB), que a Vercel, sem
GPU, nunca usa.

## Impacto

- A funcionalidade principal não funcionou em produção desde o primeiro
  deploy até o PR #7: nenhuma análise completava.
- Entre a correção e a recaída, as funções ficaram a menos de 3 MiB do
  limite: qualquer dependência nova no caminho da análise quebraria o
  deploy. A função do workflow passou com 0,02 MiB de folga.
- O código importado continuava salvo; o que faltava era o relatório.

## Correção

- `outputFileTracingIncludes` com só o runtime de CPU
  (`libonnxruntime.so.1`, `onnxruntime_binding.node`) e o pacote
  `onnxruntime-node`, apenas nas rotas que geram embeddings; os providers de
  GPU excluídos.
- Cache do modelo em `/tmp` na Vercel.
- Consequência de desenho: todo embedding passa por essas duas rotas. Incluir
  o binário em mais rotas impede a Vercel de agrupá-las e estoura o limite
  de 12 funções do Hobby, então a ação "retry knowledge" passou a enfileirar o
  projeto em vez de gerar embeddings na hora.

## O que mudou para não repetir

- `npm run measure:functions` no CI mostra o peso de cada função por pacote
  (PR #90), e o build falha acima de 200 MiB rastreados (PR #93).
- `ONNXRUNTIME_NODE_INSTALL=skip` no CI e na Vercel: o download da GPU não
  acontece mais (PR #105).
- O E2E roda na build de produção (`next start`) com embeddings reais (PR
  #16). Ele não roda na Vercel, então não pegaria este incidente; o gate de
  tamanho cobre a parte que só a Vercel mostra.
- O ADR-006 (2026-10-04) manteve o modelo local em CPU com números medidos
  em produção (carga 1,2 s, embeddings ~44 s por análise no p50), em vez de
  migrar para uma API às pressas.

## O que aprendi

Local e CI provam o código, não o pacote que vai para produção. Quando uma
dependência carrega binários nativos ou faz `require` dinâmico, o deploy
precisa ser testado onde ele roda, e o tamanho do pacote precisa ser medido
e ter um limite no CI.
