# Retro — Fase 4 (observabilidade e custo)

- **Período:** 2026-10-01 (PR #77) a 2026-10-01 (PR #84)
- **Estimado × real:** sem estimativa prévia; real de 1 dia (PRs #77 a #84)
- **Números:** a fase não prometia ganho; ela instrumenta o que o
  [baseline §5](../baseline.md) deixou sem medir (`llm_calls` e os spans no
  Sentry).

1. **O que funcionou:** custo antes de erro. `llm_calls`, o orçamento
   diário por plano, o teto por chamada e o kill switch entraram antes do
   Sentry, todos dentro do módulo billing (é regra de plano), sem porta
   nova. O kill switch em tabela, e não em variável de ambiente, desliga o
   LLM sem deploy.
2. **O que não funcionou:** dois erros só apareceram em produção. Os traces
   vão como spans em streaming e o `beforeSendTransaction` nunca rodava, então
   o token do link público vazava no `url.full` (#82). E o Next empacota o
   `instrumentation.ts` e as rotas com cópias separadas do logger: nenhum
   erro tratado chegava ao Sentry desde o #80 (#84).
3. **O que me surpreendeu:** o Sentry 11 coleta tudo por padrão. O trabalho
   não foi ligar a observabilidade, foi desligar (`dataCollection`,
   scrubbers) e provar com um token falso que nada de PII ou código do
   usuário saía.
4. **O que muda na próxima fase:** testar a instrumentação em produção logo
   depois do deploy, com um evento conhecido, e não confiar só no teste
   local. Manter 100% de trace nas rotas medidas: com 10%, quase nenhuma
   análise deixaria trace.
5. **O que eu ainda não sei explicar sem consultar** (candidatos, a
   confirmar): o caminho de um span em streaming até o Sentry e onde cada
   hook (`beforeSend`, `beforeSendSpan`) roda; por que o empacotamento do Next
   duplica módulos entre `instrumentation.ts` e as rotas.
