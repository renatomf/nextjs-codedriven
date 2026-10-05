# Retro — Fase 3 (monólito modular + Clean Architecture)

- **Período:** 2026-09-29 (ADR-001, PR #23) a 2026-09-30 (PR #50)
- **Estimado × real:** … (a tabela de planejamento do roadmap não tinha estimativa)
- **Números:** [results/phase-3.md](../results/phase-3.md)

<!--
Fatos para ajudar a lembrar (apague depois de escrever):
- Ordem: fundação (ADR-001, dependency-cruiser, erros, env) → billing (3 PRs,
  piloto) → projects (rede de testes, ciclo de vida, queries, importação,
  link público) → ingestion → analysis (caracterização, Rule/ScoringPolicy,
  correções) → chat (+ TD-28) → identity → front → fechamento.
- Método que se repetiu: rede de testes primeiro, refatoração com os testes
  inalterados como prova, mutação para provar que o teste pega o erro.
- Tropeços registrados: CI vermelho por não rodar `lint:arch` antes do push
  (teste de integração em src/app); mutação com `sed` que não se aplicou;
  relatório JSON antigo lido como resultado novo; teste de injeção que
  achava a menção aos marcadores em vez do bloco; migração colada na linha
  de comando do PowerShell (o `&` da connection string).
- Decisões que não estavam no plano: sem porta PaymentGateway (uma
  implementação só); SourceProvider adiado para a v2.2; evals e prompts
  antecipados para logo depois da Fase 3; link sem expiração para o README.
-->

1. **O que funcionou:**
2. **O que não funcionou:**
3. **O que me surpreendeu:**
4. **O que muda na próxima fase:**
5. **O que eu ainda não sei explicar sem consultar** (próximo ponto de estudo):
