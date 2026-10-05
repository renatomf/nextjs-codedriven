# Retro — Fase 6 (segurança e dados)

- **Período:** 2026-10-04 (página de dados, PR #118) a 2026-10-04 (PR #130)
- **Estimado × real:** … (a tabela de planejamento do roadmap não tinha estimativa)
- **Números:** [results/phase-6.md](../results/phase-6.md)

<!--
Fatos para ajudar a lembrar (apague depois de escrever):
- Ordem: página de dados (achado: código vai ao Groq sem redação, TD-47;
  ZDR ligado) → retenção de 90 dias → exclusão de conta → CSP Report-Only →
  ADR-007 e spike do GitHub App → 3 etapas (conectar pelo App; login sem
  `repo` e desinstalar ao sair; parar de usar e apagar o token antigo).
- Decisões que não estavam no plano: estilos inline liberados na CSP (o
  nonce protege só scripts); zod `jitless` no navegador; retenção mantém o
  projeto e o relatório; desinstalar o App só onde ninguém mais o usa (org
  compartilhada); a criptografia e o `ENCRYPTION_KEY` saíram junto com o
  token (TD-19 obsoleto).
- Medir antes de mexer: o E2E achou as violações de CSP antes de produção;
  o Playwright em produção achou o nonce faltando; um log temporário mediu
  a causa depois de duas hipóteses erradas.
- Tropeços: commit do ZDR fora do merge (#118/#119); hipótese errada da CSP
  (#123); `AUTH_URL` ausente nos previews (500 no retorno do App); ciclo de
  imports pego pelo `lint:arch`, que não tinha rodado local; nome
  `codedriven` já reservado no GitHub; o `vercel curl` criou um token de
  bypass sem perguntar.
- Ordem das migrações: 0013 (remover coluna) é *contract* e foi aplicada
  **depois** do deploy, porque o adapter do Auth.js seleciona todas as
  colunas de `users`.
- Validado: produção (CSP 0 violações nas páginas públicas; análise de
  repositório privado pelo App; 0 tokens e coluna removida); preview
  (exclusão de conta; "Redirect on update" do App).
-->

1. **O que funcionou:**
2. **O que não funcionou:**
3. **O que me surpreendeu:**
4. **O que muda na próxima fase:**
5. **O que eu ainda não sei explicar sem consultar** (próximo ponto de estudo):
