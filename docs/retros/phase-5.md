# Retro — Fase 5 (ingestão assíncrona)

- **Período:** 2026-10-02 (ADR-005, PR #87) a 2026-10-04 (PR #116)
- **Estimado × real:** sem estimativa prévia; real de 3 dias (PRs #87 a #116)
- **Números:** [results/phase-5.md](../results/phase-5.md)

1. **O que funcionou:** medir antes de mexer. O spike do Workflow achou as
   funções no limite de 250 MiB (TD-41); o `vercel inspect` mostrou o peso
   nos binários de GPU, não no `sharp`; a medição de chunks mostrou que
   projetos com mais de ~800 arquivos estourariam o step (TD-46). Em
   produção ficaram validados o reaper, o upload de ZIP pelo bucket, o
   reaproveitamento de embeddings (344 de 344), o retry e a degradação do
   LLM.
2. **O que não funcionou:** mergeei o #97 antes de aplicar a migração e a
   página de relatório quebrou em produção, porque o runbook dizia "depois
   do merge"; salvei as variáveis do Neon em Production em vez de Preview; o
   `vercel link` puxou um `.env.local` para a pasta temporária.
3. **O que me surpreendeu:** quanto do plano mudou ao encontrar a
   plataforma real: o dedupe do Stripe virou "sincronizar do estado atual"
   (cobre entrega atrasada), o outbox virou o próprio projeto, o storage foi
   o do Neon (ramifica com o banco) em vez do Vercel Blob, e o limite de 4,5
   MB de corpo da Vercel só apareceu ao planejar o job de ZIP. E a chave do
   Groq ficou inválida em produção: a degradação graciosa salvou os
   relatórios.
4. **O que muda na próxima fase:** migração aplicada antes do merge sempre
   que o código novo lê a coluna nova (o runbook passou a dizer isso), e
   conferir o ambiente de cada variável na Vercel antes de salvar (TD-36).
5. **O que eu ainda não sei explicar sem consultar** (candidatos, a
   confirmar): o modelo de execução do Vercel Workflow (o que é
   reexecutado num retry de step e por que os steps precisam ser
   idempotentes) e a diferença entre expand e contract numa migração.
