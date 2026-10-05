# Retro — Fase 3 (monólito modular + Clean Architecture)

- **Período:** 2026-09-29 (ADR-001, PR #23) a 2026-09-30 (PR #50)
- **Estimado × real:** sem estimativa prévia; real de 2 dias (PRs #23 a #50)
- **Números:** [results/phase-3.md](../results/phase-3.md)

1. **O que funcionou:** rede de testes primeiro, refatoração com os testes
   inalterados como prova e mutação para provar que o teste pega o erro. O
   billing como piloto fixou a convenção do módulo antes dos outros cinco, e
   o `dependency-cruiser` no CI transformou a regra de camadas em algo que
   falha, não em combinado.
2. **O que não funcionou:** o CI ficou vermelho porque eu não rodava
   `lint:arch` antes do push; uma mutação com `sed` não se aplicou e o teste
   "passou" sem provar nada; li um relatório JSON antigo como se fosse o
   resultado novo; colei uma migração na linha de comando do PowerShell e o
   `&` da connection string quebrou o comando.
3. **O que me surpreendeu:** quantas abstrações do plano não se pagaram ao
   olhar o código de perto: o `PaymentGateway` tinha uma implementação só e
   saiu, e o `SourceProvider` ficou para a v2.2. A regra "porta só com 2+
   implementações" cortou mais do que eu esperava.
4. **O que muda na próxima fase:** rodar `lint:arch` e os testes de
   integração antes de abrir o PR; conferir data e commit de todo resultado
   antes de usá-lo como número; e antecipar evals e prompts (Fase 7), porque
   a qualidade do relatório é o que quem avalia o projeto vê primeiro.
5. **O que eu ainda não sei explicar sem consultar** (candidatos, a
   confirmar): a fronteira entre `application` e `infrastructure` no módulo
   projects (o aggregate `Project` e o repositório Drizzle), e como o
   composition root no `index.ts` evita que um import carregue o banco.
