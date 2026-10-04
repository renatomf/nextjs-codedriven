# ADR-008 — Retenção e exclusão de dados

- **Status:** aceita — registro retroativo (2026-10-04): a decisão foi
  implementada na Fase 6 e esta ADR registra o que já vale
- **Data:** 2026-10-04
- **Fase do roadmap:** 6 — Segurança e dados (LGPD)

## Contexto

- O produto guarda **código de terceiros**: os arquivos importados, os
  chunks e os vetores de cada projeto, usados pelo chat, pelo explorador e
  pela reanálise.
- Até a Fase 6, o código ficava guardado até o usuário apagar o projeto, e
  não havia como apagar a conta.
- A conta tem dados fora do banco: o customer e a assinatura no Stripe, ZIPs
  ainda não importados no object storage (ADR-011) e instalações do GitHub
  App (ADR-007).
- Já existe um cron diário (o reaper, TD-11), com `CRON_SECRET`.

## Problema

Por quanto tempo guardar o código de um projeto, e como apagar uma conta
inteira sem deixar dados para trás nem uma assinatura cobrando?

## Opções consideradas

1. **Guardar enquanto o projeto existir** (como era). Simples, mas acumula
   código de terceiros que ninguém usa.
2. **Apagar o projeto inteiro depois de um prazo sem uso.** O usuário
   perderia também o relatório, que é o resultado que ele quer guardar.
3. **Apagar só o código depois de um prazo sem uso, mantendo o projeto e o
   relatório.** As ações que precisam do código passam a recusar.

## Decisão

**Retenção (opção 3):**

- Um projeto sem uso há **90 dias** (`CODE_RETENTION_DAYS`) perde
  arquivos, chunks e vetores. O projeto e o relatório ficam, marcados com
  `code_removed_at`.
- **Uso** é abrir o projeto ou importar o código (`last_used_at`).
- O cron diário aplica a regra numa transação que confere a regra de novo
  (o usuário pode ter aberto o projeto no meio do caminho).
- Chat, explorador e reanálise recusam no servidor um projeto sem código, e
  a página explica o motivo.

**Exclusão de conta** (`deleteAccount`), nesta ordem:

1. **Stripe primeiro** (`customers.del`, que cancela a assinatura). Se
   falhar, nada é apagado, e nenhuma assinatura fica cobrando uma conta que
   não existe mais.
2. **Uploads pendentes** no object storage. É o melhor esforço: o reaper
   apaga o que sobrar.
3. **GitHub App** desinstalado das instalações que só este usuário
   vinculou, antes que os vínculos sumam com a linha do usuário.
4. **Banco**, numa transação: o usuário e tudo o que é dele.

A ação exige a sessão, rate limit e a confirmação com o email da conta.
Nunca usa o id do formulário.

**Transparência:** a página pública `/data` diz o que vai para o Groq (com
Zero Data Retention ligado), o que fica guardado e por quanto tempo. Os
números vêm das constantes do código.

## Trade-offs e consequências

- **Melhor:** o código de terceiros não fica guardado sem uso. A exclusão
  é de ponta a ponta: um teste de integração varre **todas** as tabelas por
  id, email, customer e projeto depois da exclusão e não acha nada.
- **Pior:** um usuário que volta depois de 90 dias precisa importar o código
  de novo para usar o chat ou reanalisar.
- **Obrigatório:** toda nova tabela com dados do usuário entra na exclusão,
  e o teste de varredura a cobre. Todo novo dado externo entra na ordem
  acima, antes do banco.
- **Não medido ainda:** a primeira remoção real em produção só acontece 90
  dias depois da migração 0010 ([resultados da Fase 6](../results-phase-6.md)).
- **Revisão:** um pedido legal ou de usuário por outro prazo, ou planos com
  retenção diferente.
