# Retro — Fase 6 (segurança e dados)

- **Período:** 2026-10-04 (página de dados, PR #118) a 2026-10-04 (PR #130)
- **Estimado × real:** sem estimativa prévia; real de 1 dia (PRs #118 a #130)
- **Números:** [results/phase-6.md](../results/phase-6.md)

1. **O que funcionou:** o GitHub App em três etapas: conectar pelo App;
   login sem `repo` e desinstalar ao sair; parar de usar e apagar o token
   antigo. Cada etapa foi para produção sozinha e foi validada antes da
   seguinte, e a criptografia e o `ENCRYPTION_KEY` saíram junto com o token
   (TD-19 ficou obsoleto). A migração 0013, que remove a coluna, é
   *contract* e foi aplicada depois do deploy, porque o adapter do Auth.js
   seleciona todas as colunas de `users`.
2. **O que não funcionou:** o commit do ZDR ficou fora do merge (#118/#119);
   a primeira hipótese da CSP estava errada (#123); faltava `AUTH_URL` nos
   previews (500 no retorno do App); o `lint:arch`, que eu não tinha rodado
   localmente, pegou um ciclo de imports; o `vercel curl` criou um token de
   bypass sem perguntar.
3. **O que me surpreendeu:** a própria página de dados achou um problema
   de privacidade: o código vai ao Groq sem redação (TD-47). E a CSP: o E2E
   achou as violações antes de produção, mas o nonce faltando só apareceu no
   Playwright contra produção; um log temporário mediu a causa depois de duas
   hipóteses erradas.
4. **O que muda na próxima fase:** medir a causa com um log temporário
   antes da segunda hipótese; conferir as variáveis de ambiente dos previews
   antes de testar um fluxo de OAuth; e não aceitar comandos de CLI que criem
   credenciais sem eu ver.
5. **O que eu ainda não sei explicar sem consultar** (candidatos, a
   confirmar): como o nonce da CSP chega do proxy até o render na Vercel (a
   precedência de headers do #123 e #124) e o ciclo de vida de uma
   instalação do GitHub App numa organização compartilhada.
