# ADR-004 — Limites de custo do LLM e kill switch

- **Status:** aceita — registro retroativo (2026-10-04): a decisão foi
  implementada na Fase 4 e esta ADR registra o que já vale
- **Data:** 2026-10-04
- **Fase do roadmap:** 4 — Observabilidade e custo do LLM

## Contexto

- Três funções chamam o LLM: o **relatório** da análise, o **chat** e a
  **explicação** de arquivo do explorador. Todas usam o Groq
  (`gpt-oss-120b`).
- O Groq gratuito tem limite **por organização**: 200 mil tokens por dia e
  8 mil por minuto. Um usuário que gaste tudo derruba o serviço de todos.
- Antes da Fase 4 não havia registro do uso: não se sabia quantos tokens
  uma análise gastava nem quem gastava.
- Variáveis de ambiente não servem para desligar uma função às pressas: a
  Vercel congela as variáveis por deploy (TD-36).

## Problema

Como limitar o custo do LLM por usuário e por chamada, e desligar uma
função que chama o modelo sem esperar um deploy?

## Opções consideradas

1. **Só o rate limit por hora que já existia.** Simples, mas limita
   chamadas, não tokens: uma análise de projeto grande gasta 10 vezes mais
   que uma pequena.
2. **Orçamento de tokens por usuário e por dia, somado de um registro de
   chamadas, mais um teto por chamada e um interruptor no banco.** Exige uma
   tabela de uso e uma consulta antes de cada chamada.
3. **Limite no provedor** (chave por usuário ou projeto no Groq). O plano
   gratuito não oferece isso.

## Decisão

Opção 2, em três camadas:

- **Registro:** `recordLlmCall` grava uma linha em `llm_calls` por chamada
  (função, modelo, tokens de entrada e saída, latência, resultado e custo
  estimado pelo preço de tabela, `estimateCostMicroUsd`). Nunca grava o
  prompt nem a resposta. Uma falha ao gravar não derruba a requisição.
- **Orçamento diário por plano:** `assertLlmBudget` soma os tokens do dia
  (UTC) do usuário antes de cada chamada. São 200 mil no Free e 2 milhões
  no Premium, configuráveis por variável. O dia é o mesmo da cota de
  análises (ADR-003).
- **Teto por chamada:** `maxOutputTokens` de 8.000 no relatório (cerca de 3x
  a revisão mais longa medida nos evals de 2026-09-30) e 4.000 no chat e na
  explicação. A entrada do relatório já é limitada pelo orçamento da amostra
  (16 mil caracteres). O relatório tem timeout de 120 s; o chat e a
  explicação são limitados pela duração máxima da função (60 s).
- **Kill switch por função:** tabela `llm_switches`, lida a cada chamada,
  sem cache. Sem linha significa ligado. Desligar é um `INSERT` no SQL
  Editor ([runbook](../runbooks/llm-kill-switch.md)).

Quando o LLM não pode ser usado, cada função reage de um jeito:

- o **chat** e a **explicação** respondem 503, antes do rate limit;
- o **relatório** sai só com as verificações automáticas e grava o motivo
  (`aiReviewSkipped`: `disabled`, `budget` ou `unavailable`). A página
  avisa "Automated checks only", e o usuário pode gerar a revisão de novo
  depois (Fase 5, degradação graciosa).

## Trade-offs e consequências

- **Melhor:** o gasto de cada usuário tem teto, e um usuário não esgota a
  cota do Groq de todos. O custo por análise passou a ser medido. Uma
  função quebrada se desliga em segundos.
- **Pior:** uma consulta a mais (a soma do dia) antes de cada chamada. O
  custo é uma **estimativa** pelo preço de tabela: no plano gratuito, o
  custo real é zero.
- **Obrigatório:** toda nova chamada ao LLM passa por `assertLlmEnabled`,
  `assertLlmBudget` e `recordLlmCall`, e tem `maxOutputTokens` e um limite
  de tempo (timeout próprio ou a duração máxima da função).
- **Revisão:** sair do plano gratuito do Groq (o orçamento passaria a ser
  em dinheiro) ou ter um segundo provedor (o registro e o orçamento
  passariam a ser por provedor).
