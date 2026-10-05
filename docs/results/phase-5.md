# Resultados da Fase 5 — antes × depois

Ingestão assíncrona. Início: fechamento da Fase 4 (2026-10-02, commit
`100050d`, PR #85). Fim: **2026-10-04**, commit da `main` `1ef39e7` (PR #116).
Mesmas regras do [baseline.md](../baseline.md): cada número tem data e método;
o que não foi medido aparece como **não medido**. Decisões:
[ADR-005](../decisions/005-job-runner.md) (Vercel Workflows),
[ADR-011](../decisions/011-zip-upload-storage.md) (upload de ZIP),
[ADR-006](../decisions/006-embeddings-runtime.md) (embeddings).

## O que mudou no comportamento

| Ponto | Antes | Depois | Como foi verificado |
|---|---|---|---|
| Onde a análise roda | dentro da request `analyze` (até 300 s) | Vercel Workflow: steps com retry (2×), `FatalError` para erro do usuário | E2E no build de produção (World local); preview e produção (2026-10-03) |
| Importação do GitHub | download, extração e gravação na server action | step do workflow; a request só cria o projeto e dispara | integração; reanálise em produção (2026-10-03) |
| Upload de ZIP | acima de 4,5 MB falhava com `413` antes do app (a tela prometia 100 MB) | até **100 MB**: navegador → bucket do Neon por POST assinado → step lê, extrai, grava e apaga | spike no preview (4 testes); upload em produção: projeto `completed`, 130 arquivos, bucket vazio depois (2026-10-03) |
| "Está rodando?" | adivinhado pela última escrita (janela de 360 s) | o projeto guarda o `runId`; a rota pergunta ao Workflow | integração (5 casos; ignorar o status derruba 3); preview |
| Projeto travado em `processing` | só saía se alguém reabrisse a página | reaper diário (cron da Vercel, `CRON_SECRET`) | produção: `projects.reaped {"checked":0,"failed":0,"alive":0}` (2026-10-03) |
| LLM fora (kill switch, sem cota, provedor falhando) | o relatório falhava | relatório só com as verificações automáticas, sinalizado ("Automated checks only") | produção: chave do Groq inválida em 2026-10-03, relatórios saíram com `aiReviewSkipped: "unavailable"` |
| Chave do LLM recusada (401/403) | 3 tentativas antes de desistir | degrada na primeira | integração (a regra antiga derruba os 2 casos) |
| Mesmo código reanalisado | nota mudava (o mesmo ZIP deu verde e depois amarelo) | revisão do LLM reaproveitada por hash: mesma nota | preview: 59 e 59 (2026-10-03) |
| Embeddings de código sem mudança | todos de novo (~44 s por análise) | reaproveitados por `content_hash` + modelo | produção: `ingestion.knowledge_stored {"chunks":344,"reused":344}` (2026-10-03, 23:56 UTC) |
| Projeto perto de 1.000 arquivos | ~3.100 chunks, ~370 s num step de 300 s: falharia (estimado) | lotes de até 1.000 chunks por step (~120 s cada) | integração; projeção pela medição de chunks abaixo |
| Webhook do Stripe atrasado | um `checkout.session.completed` depois do cancelamento devolvia o premium | todo evento sincroniza do estado atual da assinatura | unitário (falhava no código antigo) |
| Falha ao baixar o modelo | ficava em cache até a instância reiniciar (TD-01) | retry com espera e a falha não fica guardada | unitário (2 de 3 falhavam no código antigo) |

## Tamanho das funções com ONNX (TD-41)

Método: `vercel inspect --json` (o número ao qual o limite de 250 MiB se
aplica) e `npm run measure:functions` no CI (Linux).

| Função | Antes (produção, 2026-10-02) | Depois |
|---|---|---|
| `analyze` | 247,8 MiB (a 2,2 MiB do limite) | 34,1 MiB (preview do #91); sem ONNX desde o #95 |
| `chat` | 243,9 MiB | 30,4 MiB |
| `flow` do Workflow (passos da análise) | — | 36,0 MiB (preview do #95) |

Causa: o `postinstall` do `onnxruntime-node` baixava os providers de GPU
(~258 MiB) e o `next.config.ts` empacotava a pasta inteira. O CI falha
acima de 200 MiB rastreados (#93) e não baixa mais esses arquivos (#105).

## Tempos em produção (Sentry)

Spans de 2026-09-27 a 2026-10-04, ambiente `production`, 10–13 amostras por
etapa (consulta `search_traces` por `span.description`):

| Etapa | p50 | p95 |
|---|---|---|
| `embeddings.embed` | 43,9 s | 46,6 s |
| `report.llm_review` | 0,6 s | 5,4 s |
| `embeddings.model_load` (cold start) | 1,2 s | 1,2 s |
| `vector.replace_chunks` | 0,4 s | 0,7 s |
| `pipeline.chunk` | 0,1 s | 0,1 s |

Projetos em produção (banco, só contagens, 2026-10-04): 12 com
conhecimento, mediana de 377 chunks, máximo de 796 (274 arquivos).

Chunks por repositório (extrator, filtros e chunker de produção, sem
embedding, 2026-10-04): Juice Shop 633 arquivos → 2.034 chunks; este
repositório 279 → 843; NodeGoat 44 → 93.

## Código e testes

| Métrica (`npm run measure:code`) | Início (`100050d`) | Fim (`1ef39e7`) |
|---|---|---|
| Arquivos de produção | 178 | 185 |
| Arquivos de teste | 64 | 71 |
| Arquivos de `src/app` com acesso ao banco | 0 | 0 |
| Arquivos com banco ou Drizzle | 18 | 18 |

Testes no fim (2026-10-04, local): **436 unitários e de componente** (+2
pulados, opt-in) e **158 de integração** (Postgres real). Contagem de casos
no início da fase: **não medida** (só os arquivos acima). Cada mudança de
regra foi conferida com uma mutação (o código antigo ou estragado derruba o
teste novo).

Migrações da fase: 0006 (`reports.llm_review`), 0007
(`projects.analysis_run_id`), 0008 (`code_chunks.content_hash` e
`embedding_model`), 0009 (`embedding_cache`) — todas só acrescentam,
aplicadas em `preview` e `main` antes do merge (exceto a 0006: ver
incidentes).

## Incidentes da fase

- **2026-10-03, #97 sem migração:** o merge saiu antes da 0006; a página de
  relatório carregava todas as colunas e quebrou para todos os projetos até
  a migração ser aplicada. Correções: consulta só com as colunas usadas
  (#98) e o runbook passou a exigir migração **antes** do merge.
- **2026-10-03, chave do Groq inválida:** relatórios saíram sem a revisão de
  IA (degradação graciosa funcionou); chave trocada pelo autor; o 401 agora
  degrada sem retry (#114).

## Não medido

| Métrica | Por quê | Como medir |
|---|---|---|
| Duração total da análise, antes × depois | não havia medição consistente antes da fase; agora há spans por etapa | trace completo de um run no Sentry (`/.well-known/workflow/v1/flow`), comparando com o §1 do baseline |
| Um projeto real perto de 1.000 arquivos | nenhum foi analisado | importar um repositório grande e ler o `embeddings.embed` de cada lote |
