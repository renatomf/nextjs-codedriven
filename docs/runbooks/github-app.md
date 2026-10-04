# GitHub App (acesso aos repositórios)

Decisão: [ADR-007](../decisions/007-github-app.md). Um App **por ambiente**:
produção e um para preview + dev. Sem as variáveis abaixo, o ambiente usa o
fluxo antigo (OAuth), sem quebrar nada.

## Criar o App

GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App**:

| Campo | Valor |
|---|---|
| Name | `codedriven` (produção) ou `codedriven-preview` |
| Homepage URL | `https://nextjs-codedriven.vercel.app` |
| Callback URL | `<URL do ambiente>/api/github/app/callback` (até 10; em preview, uma por branch testada) |
| Request user authorization (OAuth) during installation | ✅ (o callback confere a posse da instalação com o token do usuário) |
| Expire user authorization tokens | ✅ |
| **Redirect on update** | ✅ (sem isso, mudar os repositórios no GitHub não volta para o app) |
| Webhook → Active | ❌ (ADR-007: sem webhook nesta etapa) |
| Repository permissions | **Contents: Read-only**, **Metadata: Read-only**; o resto *No access* |
| Account permissions | todas *No access* |
| Where can this GitHub App be installed? | produção: **Any account**; preview: *Only on this account* |

Depois de criar: gere um **client secret** e uma **private key** (`.pem`).

## Variáveis na Vercel

Projeto → **Settings → Environment Variables → Add New**, marcadas como
*Sensitive*, **só no ambiente do App** (TD-36: nunca editar uma variável
compartilhada para dar outro valor a um ambiente):

| Key | Valor |
|---|---|
| `GITHUB_APP_ID` | "App ID" (número) |
| `GITHUB_APP_CLIENT_ID` | "Client ID" (`Iv…`) |
| `GITHUB_APP_CLIENT_SECRET` | o client secret gerado |
| `GITHUB_APP_PRIVATE_KEY` | o conteúdo inteiro do `.pem`, com as linhas `BEGIN`/`END` |
| `GITHUB_APP_SLUG` | o fim de `github.com/apps/<slug>` |

Os valores nunca passam pelo chat nem pelo repositório. Depois de colar, apague
o `.pem` local (dá para gerar outra chave no GitHub). As variáveis valem a
partir do próximo deploy.

## Rotação da chave

GitHub → App → **Generate a private key** → troque `GITHUB_APP_PRIVATE_KEY`
na Vercel → redeploy → **apague a chave antiga** no GitHub. Nada no banco
muda: só ids de instalação são guardados.

## Conferir

1. Settings → **Connect GitHub (read-only)** → instalar escolhendo um
   repositório → volta com "GitHub connected successfully".
2. New analysis lista só os repositórios escolhidos.
3. Logs: nenhum `github.installation_not_yours` inesperado; nenhum token em
   log (o código nunca loga token nem JWT).
