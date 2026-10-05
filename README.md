# codedriven

> Auditor de codebases JavaScript/TypeScript com IA: importe um repositório do GitHub (ou envie um ZIP) e receba uma nota de saúde por categoria, uma lista priorizada de problemas, um explorador que explica cada arquivo e um chat que responde com base no código real (RAG).

![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript)
![Postgres](https://img.shields.io/badge/Neon-Postgres_+_pgvector-00E5A0)
![Drizzle](https://img.shields.io/badge/ORM-Drizzle-C5F74F)
![Vercel Workflows](https://img.shields.io/badge/Vercel-Workflows-000000?logo=vercel)
![Groq](https://img.shields.io/badge/LLM-Groq-F55036)
![Auth.js](https://img.shields.io/badge/Auth-Auth.js_v5-7C3AED)
![Stripe](https://img.shields.io/badge/Billing-Stripe-635BFF?logo=stripe)
![Tests](https://img.shields.io/badge/tests-730-success)
![ADRs](https://img.shields.io/badge/ADRs-11-informational)

**Acesse:** [nextjs-codedriven.vercel.app](https://nextjs-codedriven.vercel.app) · [relatório deste repositório](https://nextjs-codedriven.vercel.app/r/ppJZrjkotodAiwr3EJXiDjQ6b7WbtQpz4aFOgxWZj7I) (link público, sem login)

![Relatório de saúde deste repositório no codedriven, modo claro](docs/assets/app-light.png)

![Relatório de saúde deste repositório no codedriven, modo escuro](docs/assets/app-dark.png)

## Sobre o projeto

**codedriven** é uma aplicação **Next.js 16 (App Router)** que faz o papel de um revisor sênior: importa um repositório, mede o código com regras determinísticas, pede a um LLM uma revisão de arquitetura, segurança e performance, e junta tudo numa nota por categoria com os problemas priorizados.

## Dogfooding

Todo pull request roda a análise sobre este repositório e sobre dois apps propositalmente vulneráveis (**OWASP NodeGoat** e **Juice Shop**, com as vulnerabilidades anotadas). Ele falha se a análise piorar ([evals/README.md](evals/README.md)).

![Nota determinística deste repositório em cada resultado de eval versionado](docs/assets/dogfooding.svg)

A nota **determinística** deixa as categorias do LLM no valor-base, para ser comparável entre resultados. A linha tracejada é a mesma medida com a fórmula da v1.

## Principais funcionalidades

- **Importação** de repositório do GitHub (por um GitHub App só de leitura) ou de ZIP até 100 MB, enviado direto do navegador para o object storage. A extração é endurecida contra zip-slip, symlinks e zip bombs, e arquivos de segredo nunca são lidos.
- **Relatório de saúde** com métricas determinísticas e a revisão do LLM, com nota por categoria: arquitetura, segurança, performance, qualidade de código e testes.
- **Evidência ou descarte:** todo achado do LLM precisa citar uma linha que exista no arquivo apontado; se a linha não existir, o achado é descartado.
- **Painel de problemas** com filtros e **explorador de código** com explicação por arquivo.
- **Chat com o codebase:** chunking com Tree-sitter, embeddings locais (MiniLM, ONNX) no pgvector, respostas em streaming com as fontes.
- **Degradação graciosa:** sem o LLM (kill switch, orçamento de tokens gasto ou provedor fora), o relatório sai só com as verificações automáticas e avisa isso na tela.
- **Link público do relatório:** revogável, com expiração opcional; só o hash do token é guardado, e a página não é indexada.
- **Planos e cobrança** com Stripe Checkout, portal e webhook assinado.
- **Privacidade:** código de projeto sem uso há 90 dias é apagado. A exclusão de conta vai de ponta a ponta (Stripe, uploads, GitHub App, banco). A página [`/data`](https://nextjs-codedriven.vercel.app/data) diz o que vai para o LLM e o que fica guardado.

## Tech Stack

| Camada | Tecnologia |
| --- | --- |
| Framework | Next.js 16 (App Router, Server Actions, `proxy.ts`), React 19 |
| Linguagem | TypeScript 5, zod 4 |
| UI | Tailwind CSS 4, shadcn/ui (Base UI) |
| Autenticação | Auth.js (NextAuth v5, sessões JWT): email e senha, GitHub, Google |
| Banco de dados | Neon Postgres + pgvector, Drizzle ORM (migrations versionadas) |
| Execução assíncrona | Vercel Workflows (análise e importação como runs duráveis) |
| Arquivos | Neon Object Storage (ZIP enviado por POST assinado) |
| LLM | AI SDK 7 + Groq (`gpt-oss-120b`, Zero Data Retention) |
| Embeddings | `@huggingface/transformers` + ONNX (`all-MiniLM-L6-v2`, 384 dimensões), em CPU |
| Parsing de código | Tree-sitter (JS, TS, TSX) |
| Integração GitHub | GitHub App (contents e metadata, só leitura) |
| Billing | Stripe |
| Observabilidade | Sentry (erros e traces, sem PII nem código do usuário), logs JSON com correlation id |
| Testes | Vitest (unidade, componentes, integração em Postgres real), Playwright (E2E) |
| Regras de arquitetura | dependency-cruiser no CI |
| Entrega | Vercel (Hobby), GitHub Actions, OSV-Scanner |

## Arquitetura

### Contexto (C4, nível 1)

```mermaid
flowchart LR
    User(["Usuário"])
    Visitor(["Visitante<br/>link público"])

    subgraph Vercel["Vercel"]
        App["codedriven<br/>Next.js 16"]
        WF["Vercel Workflows<br/>análise durável"]
        Cron["Cron diário<br/>reaper + retenção"]
    end

    DB[("Neon Postgres<br/>+ pgvector")]
    Bucket[("Neon Object Storage<br/>ZIPs enviados")]
    Groq["Groq<br/>LLM"]
    HF["Hugging Face Hub<br/>modelo de embeddings"]
    GH["GitHub<br/>login + GitHub App"]
    Google["Google<br/>login"]
    Stripe["Stripe<br/>checkout + webhook"]
    Sentry[["Sentry"]]

    User --> App
    Visitor --> App
    App --> WF
    Cron --> App
    App --> DB
    WF --> DB
    User -- ZIP por POST assinado --> Bucket
    WF --> Bucket
    WF -- revisão --> Groq
    App -- chat e explicações --> Groq
    WF -- cold start --> HF
    App --> GH
    WF -- zipball, token de 1 h --> GH
    App --> Google
    App <--> Stripe
    App -.-> Sentry
    WF -.-> Sentry
```

### Contêineres e camadas (C4, nível 2)

O sistema é um **monólito modular** ([ADR-001](docs/decisions/001-modular-monolith.md)): um único deploy Next.js, com o domínio dividido em módulos. Clean Architecture e DDD entram só onde há regra de negócio.

```mermaid
flowchart TB
    subgraph Entrega["Entrega"]
        Pages["Pages e route handlers<br/>src/app"]
        Actions["Server actions<br/>src/lib/actions"]
        Proxy["proxy.ts<br/>sessão + CSP com nonce"]
    end

    subgraph Modulos["Módulos — src/modules"]
        direction LR
        Identity["identity"]
        Projects["projects"]
        Ingestion["ingestion"]
        Analysis["analysis"]
        Chat["chat"]
        Billing["billing"]
    end

    Lib["src/lib<br/>Auth.js, pipeline, arquivos, GitHub, rate limit"]
    Shared["src/shared<br/>logger, redação, env, CSP, tracing"]
    DB[("Postgres + pgvector")]

    Pages --> Modulos
    Actions --> Modulos
    Pages --> Lib
    Modulos --> Lib
    Modulos --> Shared
    Lib --> Shared
    Modulos --> DB
    Lib --> DB
```

Cada módulo tem a mesma forma ([convenção](docs/modules.md), [ADR-002](docs/decisions/002-module-convention.md)):

```
src/modules/<módulo>/
├── domain/          # regras em TypeScript puro: sem banco, sem framework, sem process.env
├── application/     # use cases e as portas que eles usam
├── infrastructure/  # implementações: Drizzle, Stripe, GitHub, ONNX
├── index.ts         # API pública pura: tipos e regras
└── server.ts        # API pública de servidor: use cases ligados ao banco ("server-only")
```

| Módulo | Responsabilidade |
| --- | --- |
| **identity** | Conta, cadastro, credenciais, instalações do GitHub App (só ids), exclusão de conta |
| **projects** | Ciclo de vida do projeto (`queued → processing → completed/failed`), importação, link público |
| **ingestion** | Embeddings e armazenamento vetorial, atrás das portas `Embedder` e `VectorStore` |
| **analysis** | Métricas, uma regra por heurística, amostragem para o LLM, verificação de evidência, fórmula da nota |
| **chat** | Política do prompt (código como dado) e recuperação de contexto |
| **billing** | Planos, cota diária com lock transacional (`withQuota`), Stripe atrás de uma camada anticorrupção |

As regras são **verificadas no CI** (`npm run lint:arch`, baseline de violações: 0):
- `domain/` não importa infraestrutura nem frameworks;
- fora do módulo, só `index.ts` e `server.ts` podem ser importados;
- `src/app` não toca o banco;
- não há ciclos.

Uma porta só existe quando há duas implementações ou um teste precisa de um fake.

### O caminho de uma análise

```mermaid
sequenceDiagram
    autonumber
    actor U as Usuário
    participant A as Server action / rota
    participant B as billing
    participant W as Vercel Workflow
    participant G as GitHub App
    participant L as Groq
    participant D as Postgres

    U->>A: importar repositório
    A->>A: sessão, zod, dono da instalação
    A->>B: withQuota (lock, checagem, uso)
    B->>D: cria o projeto
    A->>W: dispara o run e responde na hora
    W->>G: token de 1 h, só leitura, só este repositório
    G-->>W: zipball
    W->>D: arquivos extraídos
    W->>D: chunks (Tree-sitter) e embeddings em lotes
    W->>W: métricas e regras determinísticas
    W->>L: amostra do código em blocos de dados
    L-->>W: achados com a linha citada
    W->>W: descarta achado sem evidência, agrupa, calcula a nota
    W->>D: relatório
    U->>A: acompanha o progresso
```

1. A action confere a sessão, valida com zod e checa se a instalação do GitHub App é do usuário. A **cota** é consumida numa transação com lock ([ADR-003](docs/decisions/003-quota.md)); se a falha for nossa, a análise é devolvida.
2. O trabalho pesado roda num **Vercel Workflow** ([ADR-005](docs/decisions/005-job-runner.md)): cada etapa tem até 300 s e 2 retries, e só ids passam entre as etapas. Erro do usuário encerra o run (`FatalError`), e um run que morre sem gravar a falha é encerrado pelo reaper.
3. O download usa um **token de instalação de 1 h**, só de leitura e restrito ao repositório ([ADR-007](docs/decisions/007-github-app.md)). Um ZIP vai do navegador direto para o bucket, e a etapa o lê e apaga ([ADR-011](docs/decisions/011-zip-upload-storage.md)).
4. Os **embeddings** rodam em CPU com ONNX ([ADR-006](docs/decisions/006-embeddings-runtime.md)), em lotes de até 1.000 chunks por etapa, e são reaproveitados pelo hash do conteúdo.
5. O **LLM** recebe uma amostra espalhada pelo projeto (até 16 mil caracteres), com o código delimitado como dado não confiável. O mesmo código com o mesmo prompt reaproveita a revisão anterior, então a nota não oscila.
6. Um achado sem uma linha que exista no arquivo citado é **descartado**. Achados repetidos são agrupados com penalidade decrescente ([ADR-010](docs/decisions/010-score-formula.md)).

Os fluxos de chat, link público, billing e observabilidade estão em [docs/architecture.md](docs/architecture.md).

## Segurança

- **Sessão checada no servidor** em toda page, action e rota, e não só no `proxy.ts`. Toda consulta filtra pelo `userId` da sessão, com testes de IDOR em Postgres real.
- **Nenhuma credencial do usuário guardada:**
  - o login pede só perfil e email;
  - repositórios são lidos pelo GitHub App, com token de 1 h gerado a cada uso;
  - o banco guarda só o id da instalação, vinculado depois de o GitHub confirmar que ela é do usuário.
- **Vínculo de contas por email** só quando o provedor verificou o email. Uma senha não verificada é descartada quando um provedor OAuth prova o email.
- **Entrada validada com zod** em todo handler, **rate limit** em Postgres (login, cadastro, chat, análise, billing), **mensagens de erro genéricas**, webhook do Stripe com **assinatura verificada**.
- **Código analisado tratado como dado:** delimitador aleatório por requisição no prompt, e um caso de prompt injection no eval.
- **Nada sensível em logs ou no Sentry:** sem usuário, corpos, query string, prompts ou respostas do LLM; segredos redigidos.
- **Previews isolados:** banco só com schema e segredos próprios por ambiente.
- **CSP com nonce por request**, hoje em `Report-Only` enquanto os relatórios são revisados (TD-34); framing bloqueado.

## Decisões de engenharia

As decisões ficam em [`docs/decisions/`](docs/decisions/), cada uma com contexto, alternativas e consequências:

| ADR | Decisão |
| --- | --- |
| [001](docs/decisions/001-modular-monolith.md) | Monólito modular com Clean Architecture e DDD seletivos |
| [002](docs/decisions/002-module-convention.md) | Convenção dos módulos e regras de arquitetura no CI |
| [003](docs/decisions/003-quota.md) | Cota de uso do plano: lock, checagem e uso numa transação; falha nossa devolve |
| [004](docs/decisions/004-llm-cost-limits.md) | Custo do LLM: orçamento diário de tokens por plano, teto por chamada, kill switch no banco |
| [005](docs/decisions/005-job-runner.md) | Vercel Workflows como job runner da importação e da análise |
| [006](docs/decisions/006-embeddings-runtime.md) | Embeddings em runtime serverless (ONNX em CPU, cache por hash) |
| [007](docs/decisions/007-github-app.md) | GitHub App só de leitura no lugar do OAuth App com escopo `repo` |
| [008](docs/decisions/008-data-retention.md) | Retenção de 90 dias para o código e exclusão de conta de ponta a ponta |
| [009](docs/decisions/009-evals.md) | Evals em dois níveis: determinístico obrigatório e LLM real quando a análise muda |
| [010](docs/decisions/010-score-formula.md) | Fórmula da nota: achados agrupados, penalidade decrescente, testes calibrados |
| [011](docs/decisions/011-zip-upload-storage.md) | ZIP enviado direto ao object storage até o job processá-lo |

## Estrutura do projeto

```
nextjs-codedriven/
├── src/
│   ├── app/                  # Pages, route handlers e o link público (/r/<token>)
│   ├── components/           # UI: ui/ (shadcn), shared/ e pastas por feature
│   ├── modules/              # identity, projects, ingestion, analysis, chat, billing
│   ├── lib/                  # Auth.js, server actions, pipeline, arquivos, GitHub, rate limit
│   ├── shared/               # logger, redação, env, CSP, tracing, prompt-data
│   ├── db/                   # Schema do Drizzle
│   └── proxy.ts              # Sessão das páginas protegidas + CSP com nonce
├── drizzle/                  # Migrations versionadas
├── evals/                    # Evals da análise, do chat e do LLM (casos, repositórios, resultados)
├── e2e/                      # Playwright
├── scripts/                  # Gráfico de dogfooding, medição de cobertura
└── docs/
    ├── decisions/            # ADRs
    ├── runbooks/             # Migrations, GitHub App, object storage, kill switch do LLM
    ├── retros/               # Retrospectivas por fase
    ├── architecture.md       # Como o sistema é hoje
    ├── baseline.md           # O "antes" medido
    ├── roadmap-v2.md         # Fases, escopo e critérios de saída
    └── technical-debt.md     # Dívida técnica (TD-xx)
```

## Qualidade

- **543 testes unitários** em 58 arquivos, **180 de integração** em 20 arquivos (Postgres real e descartável) e **7 E2E** (Playwright, na build de produção).
- **CI obrigatório para merge:**
  - regras de arquitetura, lint, typecheck e migrations em sincronia com o schema;
  - testes, build, integração e E2E do fluxo completo;
  - eval da análise com portões de qualidade;
  - varredura de dependências (OSV).
- **LLM eval** com o modelo real, quando o prompt ou a análise mudam:
  - **recall** contra vulnerabilidades anotadas;
  - **evidência válida**;
  - **resistência a prompt injection**;
  - **achados proibidos**, os falsos positivos conhecidos que não podem voltar.

  Cada versão do prompt fica registrada com o resultado que a mediu ([`evals/prompts.lock.json`](evals/prompts.lock.json)).
- **Medição antes de otimizar:** todo número da documentação tem data e método ([baseline](docs/baseline.md), resultados das fases [3](docs/results/phase-3.md), [5](docs/results/phase-5.md) e [6](docs/results/phase-6.md)).

## Scripts disponíveis

| Comando | Descrição |
| --- | --- |
| `npm run dev` | Servidor de desenvolvimento |
| `npm run build` / `start` | Build e servidor de produção |
| `npm run lint` / `lint:arch` / `typecheck` | ESLint, regras de arquitetura, tipos |
| `npm test` | Testes unitários e de componentes (Vitest) |
| `npm run test:integration` | Integração em Postgres **local e descartável** (recusa hosts remotos) |
| `npm run test:e2e` | Playwright |
| `npm run eval` / `eval:chart` | Evals da análise e do chat; gráfico de dogfooding |
| `npm run measure:coverage` | Cobertura real (v8) de unidade + integração |
| `npm run db:generate` / `db:migrate` / `db:studio` | Migrations e studio do Drizzle |

Integração local com Docker:

```bash
docker run -d --rm --name it-pg -e POSTGRES_USER=app -e POSTGRES_PASSWORD=app \
  -e POSTGRES_DB=app -p 5432:5432 pgvector/pgvector:0.8.6-pg18
DATABASE_URL="postgresql://app:app@localhost:5432/app" npm run test:integration
```

## Configuração

**Pré-requisitos:** Node.js 24, npm e um Postgres 16+ com a extensão `pgvector` (um projeto gratuito do [Neon](https://neon.tech) serve).

```bash
npm ci
cp .env.example .env.local   # preencha os valores
npm run db:migrate
npm run dev                  # http://localhost:3000
```

O [`.env.example`](.env.example) documenta cada variável e diz quais são opcionais. Login com GitHub ou Google, importação pelo GitHub App, billing e object storage podem ficar desligados no desenvolvimento local. A configuração de cada integração está nos [runbooks](docs/runbooks/).

> Use um **banco de desenvolvimento** (por exemplo, uma branch do Neon), nunca o de produção: migrations e dados locais vão para onde o `.env.local` apontar ([runbook de migrations](docs/runbooks/migrations.md)).

## Limitações conhecidas

O [registro de dívida técnica](docs/technical-debt.md) tem a lista completa, com gravidade e destino. As que mais afetam a leitura das notas:

- **A IA vê uma amostra**, não o projeto inteiro: até 16 mil caracteres, espalhados por pastas.
- **As bases das categorias não são calibradas** (TD-50). Só Testing é medida contra uma referência real (cobertura). Arquitetura, segurança e performance partem de um valor fixo menos os achados: arquitetura, por exemplo, não passa de 88 nem sem achados. Qualidade de código cai 13 pontos de uma vez quando o projeto passa de 8 arquivos grandes e funções longas. O plano de calibração, com metas medidas, está no TD-50.
- **"Função complexa" é contada em linhas**, não em complexidade ciclomática.
- **CSP em `Report-Only`** até os relatórios do Sentry ficarem limpos (TD-34).
- **Camada gratuita:** Vercel Hobby (funções de até 300 s, no máximo 1.000 arquivos por projeto) e Groq gratuito (limite diário de tokens).

## Origem

Construído a partir do tutorial [AliSadeghi-dev/AI-Code-Analyzer](https://github.com/AliSadeghi-dev/AI-Code-Analyzer), adaptado de Prisma para **Drizzle ORM + Neon**. A v1 (tag `v1-tutorial`) acrescentou uma camada de segurança; a v2 acrescentou arquitetura modular, execução durável, testes, evals e operação em produção.
