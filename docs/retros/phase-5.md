# Retro — Fase 5 (ingestão assíncrona)

- **Período:** 2026-10-02 (ADR-005, PR #87) a 2026-10-04 (PR #116)
- **Estimado × real:** … (a tabela de planejamento do roadmap não tinha estimativa)
- **Números:** [results-phase-5.md](../results-phase-5.md)

<!--
Fatos para ajudar a lembrar (apague depois de escrever):
- Ordem: ADR-005 e spike do Workflow → TD-41 (funções no limite de 250 MiB,
  achado no spike) → análise no workflow (#95) → TD-43 (nota instável) →
  Stripe, TD-01 → runId e reaper → degradação graciosa → GitHub no job →
  TD-45 (upload > 4,5 MB quebrado) → ADR-011 e spike do Neon Object
  Storage → ZIP no job → TD-03 (content_hash) → ADR-006 e TD-46 (lotes).
- Decisões que não estavam no plano: dedupe do Stripe trocado por
  "sincronizar do estado atual" (cobre a entrega atrasada); outbox = o
  próprio projeto; object storage do Neon em vez de Vercel Blob (ramifica
  com o banco); embedding em lotes por step.
- Achados por medir antes de mexer: o spike achou as funções no limite; o
  `vercel inspect` mostrou o peso nos binários de GPU, não no `sharp`; o
  limite de 4,5 MB da Vercel apareceu ao planejar o job de ZIP; a medição
  de chunks mostrou que ~800+ arquivos estourariam o step.
- Tropeços: merge do #97 antes da migração (página de relatório quebrada em
  produção; o runbook dizia "depois do merge"); variáveis do Neon salvas em
  Production em vez de Preview; o `vercel link` puxou um `.env.local` para
  a pasta temporária; a chave do Groq ficou inválida (a degradação salvou
  os relatórios).
- Validado em produção: reaper, upload de ZIP pelo bucket, reaproveitamento
  de embeddings (344/344), retry e degradação do LLM.
-->

1. **O que funcionou:**
2. **O que não funcionou:**
3. **O que me surpreendeu:**
4. **O que muda na próxima fase:**
5. **O que eu ainda não sei explicar sem consultar** (próximo ponto de estudo):
