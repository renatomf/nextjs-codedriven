# Object storage (Neon) para upload de ZIP

Upload direto do navegador para o bucket, lido pelo workflow da análise
([ADR-011](../decisions/011-zip-upload-storage.md)). Sem as variáveis
abaixo, o app usa o upload pela request, limitado a 4 MB (TD-45): é o caso
do desenvolvimento local e do CI.

## O que cada ambiente precisa

Um bucket e uma credencial **do branch do Neon daquele ambiente**. A
credencial vale para o branch em que foi criada e para os filhos dele:
criada no `preview`, não alcança o `main` (testado no spike: `AccessDenied`).

| Ambiente Vercel | Branch Neon | Bucket |
|---|---|---|
| Production | `main` | `uploads` (privado) |
| Preview | `preview` | `uploads` (privado) |

Variáveis na Vercel, **só no ambiente correspondente** (crie com *Add New*;
as de credencial como *Sensitive*). Nomes próprios: a Vercel pode injetar
`AWS_*` nas funções.

| Variável | Valor (Neon → Connect → Storage → *Parameters only*) |
|---|---|
| `NEON_STORAGE_ENDPOINT` | `AWS_ENDPOINT_URL_S3` |
| `NEON_STORAGE_REGION` | `AWS_REGION` |
| `NEON_STORAGE_ACCESS_KEY_ID` | `AWS_ACCESS_KEY_ID` (Sensitive) |
| `NEON_STORAGE_SECRET_ACCESS_KEY` | `AWS_SECRET_ACCESS_KEY` (Sensitive) |
| `NEON_STORAGE_BUCKET` | `uploads` |

## Configurar um ambiente

1. **Bucket:** Neon Console → projeto `codedriven` → escolha o branch →
   *Object storage* → *New bucket* → `uploads`, acesso **privado**.
2. **Credencial:** com **o mesmo branch** selecionado → *Connect* → aba
   *Storage* → *Parameters only*. O secret aparece **uma vez**: deixe a tela
   aberta até o passo 3.
3. **Vercel:** *Settings → Environment Variables → Add New*, uma por
   variável da tabela, marcando **só** o ambiente certo. Nunca cole os
   valores no chat, em issues ou em arquivos do repositório.
4. **Conferir** sem ver valores: `vercel env ls` mostra nomes e ambientes.
5. **CORS:** nada a fazer. O app aplica a regra (só `POST`, só as origens
   do próprio deploy) na primeira URL de upload de cada instância.

## Operação

- Cada upload fica em `uploads/<userId>/<uuid>.zip` e é apagado pelo step
  do workflow depois da extração (com sucesso, erro do usuário ou última
  tentativa).
- O Neon não executa regras de expiração: o reaper diário
  (`/api/cron/reap-stuck-projects`) apaga uploads com mais de 1 h
  (`uploadsDeleted` no log `projects.reaped`).
- **Trocar a credencial:** gere outra no mesmo lugar, atualize as duas
  variáveis Sensitive na Vercel, faça um redeploy e revogue a antiga
  (`neon credentials revoke <token_id>`).
