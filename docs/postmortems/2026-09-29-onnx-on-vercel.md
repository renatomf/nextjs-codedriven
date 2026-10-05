# Postmortem — A análise nunca funcionou em produção (ONNX na Vercel)

- **Data do incidente:** do primeiro deploy na Vercel (v1, até 2026-09-28) a
  2026-09-29 (PR #7); recaída de tamanho de 2026-10-02 (PR #89) a 2026-10-03
  (PR #91)
- **Severidade:** a funcionalidade principal (analisar um projeto) falhava
  em produção
- **Autor:** …

<!--
Fatos para ajudar a lembrar (apague depois de escrever):
- Sintoma: toda análise em produção falhava com "libonnxruntime.so.1.14.0:
  cannot open shared object file". Local e no CI funcionava.
- Causa raiz 1 (file tracing): o binding `.node` do onnxruntime carrega a
  biblioteca nativa por `dlopen`, e o `@huggingface/transformers` carrega o
  pacote `onnxruntime-node` por `require` dinâmico. O file tracing do Next
  não enxerga nenhum dos dois, então eles não iam para a função.
- Causa raiz 2 (ambiente): o cache do modelo ficava dentro de
  `node_modules`; na Vercel só `/tmp` aceita escrita.
- Correção (PR #7, 2026-09-29, 4 commits): incluir os binários Linux x64 em
  `outputFileTracingIncludes`; cache do modelo em `/tmp`.
  - Primeira tentativa por rota quebrou o deploy:
    `exceeded_serverless_functions_per_deployment` (Hobby: 12 funções),
    porque includes por rota impedem a Vercel de agrupar rotas. Passou a
    ser global, excluindo o que nunca roda na Vercel (trace do analyze 228
    → 110 MB), e depois só nas rotas `analyze` e `chat`.
  - Consequência de desenho: todo embedding passa por essas duas rotas (a
    ação "retry knowledge" passou a enfileirar em vez de embutir na hora).
- Recaída (TD-41): em 2026-10-02, no spike do ADR-005, `vercel inspect`
  mediu `analyze` 247,8 MiB e `chat` 243,9 MiB contra o limite de 250 MiB;
  a função do workflow saiu com 250,02 MiB. Uma dependência a mais quebraria
  o deploy.
  - Hipótese inicial errada: `sharp` (só 17,8 MiB). Causa real: o
    postinstall do `onnxruntime-node` baixa os providers de CUDA e TensorRT
    (~258 MiB) no Linux, e o include pegava a pasta `linux/x64` inteira. A
    Vercel não tem GPU.
  - Correção (PR #91): incluir só o runtime de CPU. `analyze` 247,8 → 34,1
    MiB; `chat` 243,9 → 30,4 MiB.
- O que mudou para não repetir:
  - `npm run measure:functions` no CI mostra o peso por pacote (PR #90);
  - o build falha acima de 200 MiB traced (PR #93);
  - `ONNXRUNTIME_NODE_INSTALL=skip` no CI e na Vercel, porque o download da
    GPU também derrubava o `npm ci` (PR #105);
  - E2E na build de produção (`next start`) com embeddings reais (PR #16),
    embora o E2E não rode na Vercel;
  - ADR-006 (2026-10-04) manteve o modelo local em CPU, com números: carga
    1,2 s, embeddings ~44 s por análise (p50).
- Detalhe para a seção "o que aprendi": nada disso aparecia fora da Vercel.
  Local e CI usam `node_modules` inteiro; só o deploy empacota por trace.
-->

## Linha do tempo

## Causa raiz

## Impacto

## Correção

## O que mudou para não repetir
