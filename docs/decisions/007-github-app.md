# ADR-007 — GitHub App no lugar do OAuth App para ler repositórios

- **Status:** proposta (2026-10-04)
- **Data:** 2026-10-04
- **Fase do roadmap:** 6 — Segurança e dados (TD-15, TD-16)

## Contexto

- Hoje o acesso a repositórios privados usa **OAuth App** com o escopo
  `repo` ([github.ts](../../src/lib/github.ts), `getGitHubAuthorizeUrl`).
  OAuth Apps não têm escopo de leitura para repositórios privados: o token
  guardado consegue **escrever em todos os repositórios** do usuário (TD-15).
  Ele fica no Postgres, criptografado (AES-256-GCM), e não expira.
- Há **dois fluxos** que guardam o mesmo token (TD-16): o login do Auth.js
  com GitHub (escopo `read:user user:email repo`, `auth.ts`) e o "Connect
  GitHub" próprio (`/api/github/connect` + `callback`).
- O app só precisa de três coisas do GitHub: listar os repositórios que o
  usuário pode importar (`/user/repos`), baixar o zipball
  (`/repos/{owner}/{repo}/zipball`) e conferir que o repositório existe
  antes de cobrar a reanálise (`assertGitHubSourceReady`).
- Documentação do GitHub (lida em 2026-10-04):
  - o **token de instalação expira em 1 hora** e pode ser limitado a
    repositórios e permissões na criação;
  - baixar o zipball exige só **Contents: read**; ler o repositório,
    **Metadata: read**;
  - a Setup URL recebe `installation_id`, e o GitHub avisa que ele **pode ser
    forjado**: é preciso conferir com um token do usuário que instalou;
  - o próprio App pode se desinstalar (`DELETE /app/installations/{id}`,
    autenticado por JWT do App);
  - um App aceita até 10 URLs de callback.
- Restrições: custo zero (GitHub Apps são gratuitos), Hobby da Vercel,
  previews com URL própria, segredos só na Vercel (nunca no chat ou no repo).

## Problema

Como ler os repositórios que o usuário escolher **sem** guardar uma
credencial que escreve em todos eles nem uma que nunca expira?

## Opções consideradas

1. **GitHub App com `Contents: read` + `Metadata: read`, tokens de
   instalação sob demanda.** O usuário instala o App na conta (ou org) e
   escolhe *todos* ou *alguns* repositórios. O app guarda só o
   `installation_id` (não é segredo). Para listar ou baixar, o servidor
   assina um JWT com a chave privada do App e pede um token de instalação
   de 1 h, limitado ao repositório e à permissão de leitura; o token não é
   guardado.
   - Prós: **só leitura**, imposto pelo GitHub; o usuário escolhe os
     repositórios; nada de longa duração no banco (um dump do banco não dá
     acesso a nada sem a chave do App); um fluxo só (resolve TD-16); o App
     pode se desinstalar quando a conta é apagada.
   - Contras: uma chave privada RSA a guardar na Vercel (mais sensível que
     um client secret: ela emite tokens para todas as instalações); um App
     por ambiente; o usuário passa por uma tela a mais do GitHub; org pode
     exigir aprovação de um admin.
2. **Fine-grained personal access token colado pelo usuário.** Tem
   `Contents: read` por repositório e expiração.
   - Prós: só leitura; nenhum App a registrar.
   - Contras: o usuário cria e cola um segredo à mão (pior experiência e
     erro comum); o token continua guardado no banco por meses; renovar é
     manual.
3. **Continuar com o OAuth App (`repo`).**
   - Contras: mantém a escrita em todos os repositórios, o token que nunca
     expira e os dois fluxos. É o problema que o TD-15 registra.
4. **Só repositórios públicos, sem credencial.**
   - Prós: nenhum segredo do usuário.
   - Contras: perde os repositórios privados, que são o caso principal de
     uma auditoria de código.

## Decisão

**Opção 1**, condicionada a um **spike no preview** (como no ADR-011) que
prove, com um App de teste instalado em um repositório privado:

| Pergunta | Como provar |
|---|---|
| Token de instalação gerado no servidor (JWT RS256 com `node:crypto`, sem dependência nova) | `POST /app/installations/{id}/access_tokens` responde 201 e `expires_at` ≈ 1 h |
| Lista só os repositórios escolhidos | `GET /installation/repositories` com o token |
| Baixa o zipball privado | `GET /repos/{owner}/{repo}/zipball` → 200 |
| **Não consegue escrever** | `PUT /repos/{owner}/{repo}/contents/x` com o mesmo token → 403 |
| `installation_id` forjado é recusado | callback com um id de outra conta → recusado (o token do usuário não lista essa instalação em `GET /user/installations`) |
| O App se desinstala | `DELETE /app/installations/{id}` → 202 |

### Como fica

- **Login com GitHub continua no OAuth App, com escopo mínimo**
  (`read:user user:email`): ele só identifica o usuário. O token do login
  deixa de ser guardado.
- **Acesso a repositórios só pelo GitHub App** ("Connect GitHub" →
  instalação). No fim da instalação, o GitHub devolve `installation_id` e um
  `code` ("Request user authorization during installation"); o servidor
  troca o `code` por um token do usuário, confere que o `installation_id`
  está em `GET /user/installations` e só então grava a ligação
  usuário ↔ instalação. O `state` assinado e o cookie de nonce de hoje
  continuam (CSRF).
- **Tabela nova `github_installations`** (`user_id` com cascade,
  `installation_id`, `account_login`). Nenhum token é guardado.
- **Tokens de instalação** pedidos a cada uso, limitados ao repositório e
  a `contents: read`, nunca guardados nem logados.
- **Desconectar ou apagar a conta**: apaga a ligação e desinstala o App
  (`DELETE /app/installations/{id}`) se nenhum outro usuário do app usa a
  mesma instalação (instalações de org podem ser compartilhadas).
- **Instalação removida no GitHub**: detectada quando o token falha
  (404/401); a ligação é apagada e o usuário vê "conecte de novo". Sem
  webhook nesta etapa (menos superfície; se entrar depois, com assinatura
  verificada).
- **Um App por ambiente**: produção e um para preview + dev (callbacks dos
  dois domínios). Variáveis `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`,
  `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_SLUG`,
  separadas por ambiente na Vercel (TD-36: *Add New*, nunca editar a
  compartilhada). Criadas pelo autor; nunca coladas no chat.
- **Migração dos tokens antigos**: depois do deploy, os grants do OAuth App
  são revogados (`DELETE /applications/{client_id}/grant`, melhor esforço) e
  a coluna `users.github_access_token` é zerada; numa etapa *contract*
  posterior, removida. Projetos do GitHub continuam; a reanálise pede a
  instalação.

## Trade-offs e consequências

- **Fica melhor:** só leitura nos repositórios escolhidos; nenhuma
  credencial de longa duração do usuário no banco; um fluxo de conexão;
  apagar a conta também remove o acesso do lado do GitHub.
- **Fica pior:** a chave privada do App passa a ser o segredo mais sensível
  (emite tokens de leitura para todas as instalações). Mitigação: só na
  Vercel, por ambiente, rotacionável no GitHub sem mexer no banco.
- **Obrigatório:** conferir a posse do `installation_id` com o token do
  usuário; tokens limitados por repositório; nunca logar token nem JWT.
- **Revisar se:** o login também migrar para o GitHub App (um App só); o
  app precisar reagir na hora a uma desinstalação (webhook); ou o GitHub
  passar a oferecer escopo de leitura para OAuth Apps.
