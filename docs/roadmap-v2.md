# Roadmap v2 — do tutorial a uma plataforma de Code Intelligence

Consolida o roadmap original de 18 fases, o [brainstorm-v2.md](brainstorm-v2.md)
e as dívidas do [technical-debt.md](technical-debt.md) (TD-xx). Onde os três
divergem, vale este documento. **O escopo da v2.0 está fechado**: o que não
estiver aqui vai para a v2.x ou v3.

**Narrativa:** "peguei uma aplicação RAG full-stack funcional, medi,
identifiquei os limites e evoluí de forma incremental, com testes, medições e
ADRs".

---

## 0. Regras do jogo

1. **Nada muda sem rede de testes.** Nenhum refactoring entra com CI vermelho
   ou sem teste cobrindo o comportamento tocado.
2. **Um módulo por vez (strangler).** O código antigo em `src/lib` convive com
   `src/modules` até cada módulo migrar por completo. Nada de "big bang".
3. **Arquitetura onde há regra de negócio.** Clean Architecture e DDD tático em
   ingestion, analysis, chat, billing e projects. UI, CRUD simples e a
   integração com NextAuth ficam pragmáticos.
4. **Interface (porta) só quando existem 2+ implementações ou quando o teste
   precisa de um fake.** Sem interfaces artificiais.
5. **Medir antes de otimizar.** Evals e observabilidade vêm antes de mexer em
   prompt, RAG ou performance. Nenhum número vai para o README sem medição.
6. **Segurança continua sendo corrigida na hora**, em qualquer fase. As regras
   do CLAUDE.md (sessão no servidor, escopo por `userId`, zod, erros genéricos,
   rate limit) valem para todo código novo.
7. **Trunk-based:** branches curtas, PR pequeno, CI obrigatório. Uma tag por
   marco (`v1-tutorial`, `v2.0.0`, `v2.1.0`...). Nada de branch `v2` de longa
   duração.
8. **Escopo fechado.** Ideia nova durante a v2.0 vai para a seção
   [Backlog v2.x](#backlog-v2x--v3), não para a fase atual.

### Definition of Done (toda fase)

- [ ] Código + testes (unit e integração quando tocar DB ou provider externo)
- [ ] CI verde: lint, typecheck, unit, integração, build, regras de arquitetura
- [ ] Nenhuma regressão no E2E do fluxo principal
- [ ] Métrica antes × depois registrada, quando a fase promete ganho
- [ ] ADR quando houver decisão com alternativas reais, escrita com as
      próprias palavras
- [ ] `technical-debt.md` atualizado (TDs resolvidos marcados, novos registrados)
- [ ] Retro de 5 linhas em `docs/retros/`
- [ ] Consigo explicar o fluxo e as decisões da fase sem consultar nada

---

## 1. Escopo da v2.0

Cada fase tem itens **obrigatórios** (a v2.0 não sai sem eles) e itens
**se sobrar** (entram se houver tempo; senão vão para a v2.x sem culpa).

### Planejamento

| Fase | Estimativa (semanas) | Real | Status |
|---|---|---|---|
| Marco 0 — Congelar a v1 | | | |
| 1 — Baseline | | | |
| 2 — Rede de segurança | | | |
| 3 — Monólito modular + Clean Architecture | | | |
| 4 — Observabilidade e custo | | | |
| 5 — Ingestão assíncrona | | | |
| 6 — Segurança e dados | | | |
| 7 — Evals + qualidade da análise | | | |
| Encerramento v2.0 | | | |

**Ordem de execução (decidida em 2026-09-30):** Fase 3 → **Fase 7 (evals e
prompts)** → Fases 4, 5 e 6. A qualidade do relatório é o que quem avalia
o projeto vê primeiro (o link público de demonstração), e a Fase 3 já deixou
prontas as peças que o eval precisa (`ScoringPolicy`, o fake do LLM, a
caracterização da análise em snapshot). As Fases 4 a 6 não dependem da 7.

### Critérios de saída da v2.0

- [ ] CI verde em todo PR, com testes de IDOR e o E2E do fluxo principal
- [ ] Zero import de `@/lib/db` / `@/db/schema` em `src/app`
- [ ] Regras de dependência entre camadas e módulos verificadas no CI
- [x] Análise rodando em job, com retry e sem projetos travados
- [x] Relatório sai (só determinístico) mesmo com o LLM fora
- [ ] Token de GitHub só com leitura (GitHub App)
- [x] `npm run eval` com resultado versionado; nenhuma categoria do próprio
      repo zerada por ruído (2026-09-30, `c75ebff`: Code Quality 0 → 67,
      Testing 0 → 16; Testing segue baixo pelo limite do proxy de testes,
      v2.1)
- [ ] `baseline.md` × números atuais publicados no README

---

## Marco 0 — Congelar a v1

- [x] Tag `v1-tutorial` no commit atual (é o "antes" de toda a história).
- [x] README real no lugar do template do `create-next-app`: o que o app faz,
      stack, setup local, variáveis de ambiente (sem valores), diferenças em
      relação ao tutorial (Drizzle/Neon, camada de segurança).

## Fase 1 — Baseline

**Obrigatório**

- [x] `docs/architecture.md` (hoje [architecture-baseline.md](architecture-baseline.md)) descrevendo **como está**, não como deveria ser:
  - C4 nível 1 e 2 (usuário, Next.js, Neon/pgvector, Groq, GitHub, Stripe,
    Hugging Face hub).
  - Fluxos: importação (GitHub/ZIP → `project_files`), análise
    (`POST /api/projects/[id]/analyze` → `runFullProjectAnalysis`, síncrono,
    `maxDuration = 300`), chat RAG, billing/webhook.
  - Mapa de acoplamento: 6 pages, as actions, as rotas e `lib/analysis`
    falam direto com Drizzle e Groq.
- [x] `docs/baseline.md`, com data e método de cada medida:

| Métrica | Como medir |
|---|---|
| Duração da análise | 3 repositórios de referência (pequeno, médio, este repo) |
| Latência do chat | p50/p95 de 20 perguntas fixas |
| Tokens e custo por relatório | log das chamadas ao Groq |
| Score do próprio repo | 41/100; Code Quality 0 e Testing 0 (detalhamento abaixo) |
| Testes | 7 arquivos unitários, 1 E2E (landing), sem CI |

**Detalhamento do score do próprio repo** (só a parte determinística, antes
de qualquer achado do LLM):

- Code Quality: base 72 − 96 = 0. Um arquivo grande + 12 "funções
  complexas", a maioria componentes React com JSX longo, e um falso positivo
  (`const categoryScores = (...)` contado como função de 262 linhas, TD-31).
- Testing: base 40 − 108 = 0. Cobertura por nome de arquivo de 5% (−12) +
  8 "áreas críticas sem teste" (−12 cada), das quais parte é UI com `auth` no
  caminho e 2 são scripts de `.claude/skills/**`.
- Causa principal: penalidade linear e sem teto em `scoreFromIssues`.

## Fase 2 — Rede de segurança

**Obrigatório**

- [x] **CI no GitHub Actions:** `lint`, `typecheck`, `test`, `build`. Actions
      fixadas por SHA. Checks obrigatórios no ruleset da `main`.
- [x] **Migrations só via `drizzle-kit migrate`:** o CI falha se o
      `schema.ts` mudar sem migration e aplica as migrations do zero a cada
      PR; `db:push` removido (o `.env.local` aponta para produção); fluxo
      preview → produção e expand/contract em
      [`docs/runbooks/migrations.md`](runbooks/migrations.md).
- [x] **Banco isolado para os testes de integração:** Postgres + pgvector
      (pg18) como service container do GitHub Actions, com as migrations
      reais do Drizzle a cada execução. Troca da ideia original ("branch do
      Neon por PR"): custo zero, sem dados de produção, sem segredos no CI, e
      sem esbarrar no limite de branches do plano gratuito.
- [x] **Previews sem dados nem segredos de produção (TD-36):** um único
      branch **schema-only** do Neon (`preview`) para todos os previews, e
      variáveis só de preview na Vercel (sem `AUTH_URL`, com `AUTH_SECRET`,
      `ENCRYPTION_KEY` e `GROQ_API_KEY` próprios; OAuth e Stripe só em
      produção).
- [ ] **Testes de caracterização**, por prioridade de risco:
  1. [x] Segurança (código puro): `extract` (zip-slip, zip bomb, symlink,
     limite de entradas, arquivo sensível), `encryption` (ida e volta,
     adulteração, AAD de outro usuário), estado OAuth do GitHub (expirado,
     nonce, usuário, HMAC), `validations/auth` (limites, senha > 72 bytes).
  2. [x] Núcleo da análise: `chunking` (tipos de nó, profundidade, tamanho),
     regressão do falso positivo `const x = (expr)` em `metrics` (TD-31),
     `scoreFromIssues` fixando o comportamento atual.
  3. [x] Regras de billing do TD-25 (reset à meia-noite UTC, `past_due`
     mantendo premium).
- [x] **Fronteira HTTP** (handler chamado direto, `auth()` mockado): sem
      sessão → 401, input inválido → 400 sem detalhes internos, rate limit →
      429.
- [ ] **Webhook do Stripe (TD-37):** rota com verificação de assinatura
      (`constructEvent`) que sincroniza cancelamento, falha de pagamento e
      expiração; teste de assinatura inválida → 400.
- [x] **Testes de integração de IDOR:** o usuário B nunca lê, altera ou apaga
      um projeto, arquivo, relatório ou chat do usuário A. Também cobrem o
      limite de projetos sob concorrência e a exclusão em cascata.
- [x] **E2E do fluxo principal (Playwright):** registrar → upload de um ZIP
      gerado no teste → análise → relatório → chat, contra a build de
      produção (`next start`) e o Postgres descartável do CI. LLM falso
      (`MockLanguageModelV4`, só com `E2E_FAKE_LLM=1`, recusado na Vercel);
      embeddings **reais**, para cobrir a busca vetorial de verdade.
- [x] **Dependências:** Dependabot (npm + Actions) e `osv-scanner` no CI,
      com exceções com prazo em `osv-scanner.toml`; origem dos pacotes menos
      conhecidos verificada no npm (`cn`, `shadcn`, `@neon/*` são dos
      mantenedores oficiais); `@shadcn/react` e `@neon/env` removidos (sem
      uso), `@neon/config` movido para dev. `shadcn` fica em `dependencies`
      (o `globals.css` importa `shadcn/tailwind.css`).
- [x] **Migrar `@xenova/transformers` → `@huggingface/transformers`**
      (TD-35), com teste de equivalência dos embeddings e revisão do modelo
      fixada (TD-05).

**Se sobrar**

- [ ] Acessibilidade com `@axe-core/playwright` nos E2E.

## Fase 3 — Monólito modular + Clean Architecture

Decisão registrada na **ADR-001** (escrita pelo autor). Critério para tudo
que entra: resolve um problema real deste código e é defensável numa
entrevista — sem camadas especulativas.

**Princípios**

1. **Regra de dependência:** `app` → `application` → `domain`;
   `infrastructure` implementa as portas de `application`. O domínio não
   conhece Next, Drizzle, Groq nem Stripe.
2. **Porta só com 2+ implementações reais** (o fake de teste conta).
3. **DI por funções factory** no `index.ts` de cada módulo, sem container.
4. **Strangler:** um módulo por PR; teste de caracterização no nível do use
   case antes de mover; o código antigo é apagado no mesmo PR.
5. **Regras verificadas pelo CI** (`dependency-cruiser`), não só combinadas.

**Estrutura alvo**

```
src/
├── app/                  # entrega: pages, route handlers e server actions finos
├── components/           # UI por feature (mesmos nomes dos módulos), shared/, ui/
├── modules/
│   ├── billing/  projects/  ingestion/  analysis/  chat/  identity/
│   │   ├── domain/          # entidades, value objects, regras (TS puro)
│   │   ├── application/     # use cases, queries e as portas que usam
│   │   ├── infrastructure/  # Drizzle, Stripe, Groq, GitHub, ONNX...
│   │   └── index.ts         # API pública do módulo + composition root
└── shared/               # logger ✅, env, errors, db, crypto, rate-limit
```

**Regras de dependência** (no CI com `dependency-cruiser`):

- `domain` não importa `application`, `infrastructure`, `next`,
  `drizzle-orm`, `ai` nem `stripe`.
- `application` depende só de `domain` e das próprias portas.
- Um módulo só importa outro pelo `index.ts` dele.
- `src/app` e `src/components` nunca importam `db` ou `@/db/schema`.
- React nunca entra em `src/modules`.

**Mapa dos módulos**

| Módulo | Domínio (regra pura) | Application | Infrastructure |
|---|---|---|---|
| **billing** (piloto) | `Plan`, mapeamento de status do Stripe, política de cota (reset 00:00 UTC, carência do `past_due`) | `startCheckout`, `handleStripeEvent`, `syncSubscription`, `getBillingSnapshot` | `StripeGateway`, repositório Drizzle |
| **projects** | **Aggregate `Project`** (máquina de estados, claim, detecção de travado); VOs `RepoRef`, `SafeFilePath` | `importFromGitHub`, `importFromZip`, `startAnalysis`, `deleteProject`, `cancelAnalysis`, queries das pages, **link público** | repositório Drizzle, `GitHubSource`, `ZipSource`, `ProjectFilesStore` |
| **ingestion** | regras de chunking | `buildKnowledge` | `Embedder` (ONNX), `VectorStore` (pgvector), Tree-sitter |
| **analysis** | **`Finding`** (severidade, categoria, evidência), **`Rule`** (cada heurística), **`ScoringPolicy`** | `runAnalysis`, `generateReport` | `LlmReviewer` via `LlmProvider` |
| **chat** | política do prompt (código tratado como dado) | `answerQuestion` (RAG) | reaproveita `VectorStore` e `LlmProvider` |
| **identity** | — (CRUD e integração) | `register`, `connectGitHub` | NextAuth, criptografia de tokens |

**Portas e a 2ª implementação que justifica cada uma**

| Porta | Implementações |
|---|---|
| `LlmProvider` | Groq · fake (E2E, já existe) · Ollama (modo local, v2.2) |
| `Embedder` | ONNX local · fake (testes de use case) |
| `VectorStore` | pgvector · em memória (testes de use case) |
| `SourceProvider` | GitHub · ZIP · pasta local (v2.2) |
| Repositórios | Drizzle · em memória (use cases; o Drizzle é coberto pela integração) |
| `PaymentGateway` | Stripe · fake |
| `AnalysisRunner` | síncrono, dentro da request (hoje) · job em fila (Fase 5) |

**Não criar:** repositório genérico ou "base repository", container de DI,
barramento de CQRS ou de eventos, DTOs e mappers para tudo, entidades
anêmicas por formalidade. Sem regra de negócio (settings, perfil,
dashboard), fica uma query simples. Eventos de domínio (`AnalysisCompleted`)
só em processo (retorno/callback); viram gatilho de job na Fase 5.

**Fidelidade da análise: bug objetivo agora, calibragem com eval depois**

- **Na Fase 3** (verificável sem eval, com teste): falso positivo da regex
  `const x = (expr)` (o `it.fails` do TD-31 vira `it`); `src/test/` não
  reconhecido como testes; detector de segredos rodando em fixtures de
  teste; `Finding` com **evidência** (arquivo, linhas, trecho) no modelo.
- **Refatoração que prepara a Fase 7:** cada heurística vira uma `Rule` e o
  score vira uma `ScoringPolicy`, **preservando o comportamento atual**
  (garantido pelos testes de caracterização).
- **Na Fase 7** (muda números, exige eval): teto/penalidade decrescente,
  agrupar achados repetidos, amostragem de chunks, prompt e evidência
  obrigatória para high/critical, métricas pela AST.

**Escalabilidade (o que é honesto dizer)**

A Fase 3 não escala o app sozinha: cria os pontos de troca. O gargalo
medido é ~0,11 s por chunk de embeddings em CPU **dentro da request**
(`maxDuration` 300 s ⇒ teto de ~2.700 chunks). Fase 3: `AnalysisRunner` como
porta, handlers sem estado, módulos com fronteira clara (a ingestão pode
virar worker). Fase 5: fila com retry e idempotência. Fase 7: índice HNSW,
medido antes e depois.

**Ordem dos PRs**

1. **ADR-001** (autor) e `docs/glossary.md` (linguagem ubíqua).
2. **Fundação:** `src/modules/`, `shared/env` (zod, falha no boot),
   `shared/errors` (TD-33), `dependency-cruiser` no CI.
3. **billing** (piloto, define as convenções; TD-24; ADR-003 da cota).
4. **projects:** aggregate, repositório, queries (as pages deixam de importar
   o Drizzle), **link público do relatório**; TD-12, TD-14, TD-04.
5. **ingestion:** `Embedder`, `VectorStore`, `SourceProvider`.
6. **analysis:** `Rule`, `Finding`, `ScoringPolicy`, `LlmReviewer`,
   `AnalysisRunner` e as correções objetivas.
7. **chat:** use case de RAG.
8. **identity:** acesso a dados atrás do módulo.
9. **Front** (ver [Front e estado](#front-e-estado)).
10. **Fechamento:** `architecture.md` do "depois", comparação com o
    baseline, retro. Feito: [architecture.md](architecture.md) (o "antes"
    em [architecture-baseline.md](architecture-baseline.md)),
    [results-phase-3.md](results-phase-3.md) e
    [retros/phase-3.md](retros/phase-3.md) (a escrever pelo autor) e a
    convenção dos módulos definitiva na
    [ADR-002](decisions/002-module-convention.md). Falta medir em produção
    o score do próprio repo e a duração da análise.

**Metas medidas (mesmo script do baseline)**

| Métrica | Antes (2026-09-29) | Meta |
|---|---|---|
| Arquivos em `src/app` importando o banco | 12 | **0** — atingido (baseline de arquitetura 24 → 0) |
| Arquivos importando o Drizzle | 27 | só `infrastructure/` e `shared/` |
| Lugares que mudam o status do projeto | 3+ | **1** (o aggregate) |
| Violações de camada no CI | não verificado | **0**, bloqueando o merge |

**Obrigatório**

- [x] [ADR-001](decisions/001-modular-monolith.md) — monólito modular com
      Clean Architecture seletiva.
- [x] [`docs/glossary.md`](glossary.md) (linguagem ubíqua).
- [x] Módulos billing, projects, ingestion, analysis e chat migrados
      (analysis: domínio, regras e nota; a geração do relatório migra com o
      `LlmReviewer` na Fase 7 — ver [architecture.md](architecture.md)).
      Progresso: **billing concluído** — planos e cota (`withQuota`),
      Stripe atrás de uma camada anticorrupção, chamadores migrados e
      `src/lib/billing` removido; TD-24 resolvido; regras da cota na
      [ADR-003](decisions/003-quota.md). **projects** — rede de testes do
      ciclo de vida (claim da análise, cancelamento, reanálise) em Postgres
      real, verificada com mutações; ciclo de vida no módulo (regra
      `analysisStart` + todas as escritas de status num só arquivo); queries
      das pages do projeto no módulo (dashboard, issues, progress, report e
      rota de status sem Drizzle; baseline 24 → 12); rede de testes da
      importação + reembolso da cota em falha nossa (TD-12) e TD-14;
      importação no módulo (`importArchive`, criação do projeto e busca de
      duplicado); link público do relatório — backend (tabela
      `report_shares`, token só como hash, revogação, expiração, redação de
      segredos) e interface (compartilhar, copiar, revogar; página pública
      `/r/<token>` com rate limit por IP, `noindex` e `no-referrer`).
      **ingestion** — rede de testes da montagem do knowledge (chunking
      real + pgvector real, modelo trocado por vetores determinísticos),
      verificada com mutações; módulo com o caso de uso `storeKnowledge`,
      portas `Embedder` e `VectorStore` (testadas com fakes) e TD-04;
      `SourceProvider` fica para a v2.2 (a 3ª implementação, pasta local).
      **analysis** — caracterização: snapshot completo das heurísticas
      (inclusive os falsos positivos conhecidos) e da geração do relatório
      em Postgres real (notas, ordem das issues, roadmap), verificada com
      mutações; `Finding` (com evidência opcional), uma `Rule` por
      heurística e `ScoringPolicy` no módulo, com os snapshots idênticos;
      correções objetivas (TD-31, `src/test/`, segredos em fixtures);
      **chat** — caracterização da rota (RAG em Postgres real com o
      modelo falso do E2E: resposta, fontes em ordem, prompt em snapshot,
      isolamento, sem knowledge, limite da pergunta); módulo chat (política
      do prompt no domínio, busca de contexto no `server.ts`); rotas do chat
      e do explorer sem Drizzle (baseline 12 → 6); TD-28: código como dado
      no prompt (blocos com delimitador aleatório por requisição) no chat,
      no explain e na revisão do relatório; identity (conexão com o
      GitHub e dados da conta, a página de settings só recebe um booleano
      do token). Convenção
      provisória em [`docs/modules.md`](modules.md).
- [x] identity: acesso a dados atrás do módulo (`src/modules/identity`):
      conexão com o GitHub, dados da conta, cadastro por e-mail,
      verificação de credenciais e o que cada login registra. O
      `lib/auth.ts` ficou só com a configuração do NextAuth.
- [x] Queries por módulo para todas as pages (sai o Drizzle de `src/app`):
      baseline de arquitetura zerada.
- [x] `dependency-cruiser` no CI (`npm run lint:arch`): regras da ADR-001;
      as 24 violações atuais (12 arquivos de `src/app` × banco e schema) ficam
      num baseline e só as **novas** falham. O baseline só pode diminuir.
- [x] Erro de domínio seguro para o usuário (TD-33): `DomainError` em
      `shared/errors`; `publicErrorMessage` único (TD-32).
- [x] Env vars validadas no boot (`src/instrumentation.ts` + `shared/env`):
      obrigatórias param o servidor; opcionais inválidas geram aviso e
      desligam só a integração. Erros não tratados de render/action/rota vão
      para o logger (`onRequestError`). As leituras de `process.env` migram
      junto com cada módulo.
- [x] **Logger estruturado** em `src/shared/logger.ts` (TD-26), antecipado da
      Fase 4 para ajudar a própria refatoração: uma linha JSON por evento,
      erro real (nome, mensagem, stack, causa) só no servidor, correlation id
      (`x-vercel-id`), redação de segredos por nome de campo e por padrão no
      texto. Substituiu as 26 chamadas `console.*`, a maioria das quais
      descartava o erro.
- [x] Correções objetivas da análise (TD-31, `src/test/`, segredos em
      fixtures) e `Rule`/`Finding`/`ScoringPolicy` preservando o
      comportamento.
- [x] **Link público de um relatório** (somente leitura): token aleatório com
      expiração, revogável, com rate limit; expõe só o relatório, nunca
      código-fonte nem chat. Substitui a "conta de demonstração" do
      encerramento: quem avalia abre um relatório real sem criar conta.
- [x] **Front** (ver [Front e estado](#front-e-estado)): hook
      `useAnalysisProgress`, `report/page.tsx` dividido em seções server
      component, filtros do issues dashboard na URL, fetch do explorer com
      `AbortController`; Testing Library + jsdom para os componentes
      interativos. Feito: Testing Library + jsdom (`*.test.tsx`, jsdom por
      arquivo) com testes de caracterização de `AnalysisProgress`,
      `IssuesDashboard` e `CodeExplorer`; o `AbortController` do explorer
      já existia e agora é coberto por teste (verificado com mutação). Hook
      `useAnalysisProgress` extraído e relatório em seções (`ScoreOverview`,
      `CategoryCards`, `RoadmapList`, `TopIssues`), com os testes
      inalterados; filtros do issues dashboard na URL
      (`?severity=&category=`, via `history.replaceState`, valores
      desconhecidos ignorados).

**Se sobrar**

- [ ] identity: um único fluxo de conexão com o GitHub (TD-16), lista única
      de rotas protegidas (TD-20), `publicErrorMessage` em `shared` (TD-32).
- [ ] **Log de auditoria** a partir dos eventos de domínio (exclusão de
      projeto, conexão/desconexão do GitHub, mudança de plano), em tabela só
      de inserção.
- [ ] Mutation testing (Stryker) só em `modules/*/domain`.
- [ ] Orçamento de bundle: garantir que `@huggingface/transformers`,
      `onnxruntime-node` e `tree-sitter` nunca entrem no bundle do cliente.

## Fase 4 — Observabilidade e custo

Vem antes da ingestão assíncrona: job em segundo plano sem log é caixa preta.

**Obrigatório**

- [x] ~~Logger estruturado~~ — feito na Fase 3 (ver lá).
- [x] Sentry (erros + tracing) com PII e código-fonte fora dos eventos.
      Feito: `@sentry/nextjs` 11 no servidor (`instrumentation.ts`) e no
      navegador (`instrumentation-client.ts`, `global-error.tsx`); sem
      `NEXT_PUBLIC_SENTRY_DSN` fica desligado. Todo `logger.error` também
      vai ao Sentry (os erros tratados com 500 genérico não chegariam). O SDK
      11 coleta tudo por padrão: `dataCollection` desliga usuário, cookies,
      headers, corpos HTTP, query string, valores de consulta e,
      principalmente, entradas e saídas do LLM (o prompt tem o código do
      usuário). `beforeSend` ainda remove `extra`, contextos fora de uma
      lista, breadcrumbs de console e tokens de compartilhamento, e mascara
      segredos. Sem Session Replay (gravaria o código na tela). Traces: 10%
      em produção. Source maps do navegador: TD-40.
      Correção (2026-10-01, visto em produção pelo Sentry): o SDK 11 envia
      traces como spans em streaming, e `beforeSendTransaction` nunca roda;
      o `url.full` dos spans levava o token de `/r/<token>`. `beforeSendSpan`
      (`scrubSpan`) aplica as mesmas regras aos spans, e o flush roda dentro
      do `waitUntil` da Vercel.
- [x] Tokens, custo e latência por chamada de LLM, gravados por `userId` e
      `projectId`. Feito: tabela `llm_calls` (migração 0004), uma linha por
      chamada do relatório, do chat e da explicação, com sucesso e falha
      (tokens, latência, modelo e custo estimado a preço de tabela do Groq:
      gpt-oss-120b US$ 0,15/0,60 por 1M de tokens de entrada/saída, lido em
      2026-10-01; modelo sem preço conhecido fica sem estimativa). Só
      números, nunca o prompt ou a resposta. Apagar um projeto não apaga o
      gasto do dia (`ON DELETE SET NULL`). Gravar nunca derruba a
      requisição do usuário (falha vai para o log). No chat, o uso vem do
      `onEnd` do stream (`onError`/`onAbort` gravam falha).
- [x] Orçamento de tokens por usuário/dia e teto por análise. Feito:
      orçamento diário por plano (entrada + saída, falhas incluídas, dia de
      cota em UTC), somado da `llm_calls` e checado antes de cada chamada do
      relatório, do chat e da explicação (`assertLlmBudget`; no relatório,
      dentro de `generateProjectReport`, onde todos os caminhos terminam).
      Padrão Free 200k / Premium 2M tokens por dia
      (`PLAN_FREE_LLM_TOKENS_PER_DAY`, `PLAN_PREMIUM_LLM_TOKENS_PER_DAY`),
      dimensionado pelos evals de 2026-09-30: relatório até ~8,5k tokens (x2
      com o retry de JSON), resposta de chat até ~4,3k. Teto por chamada
      (`maxOutputTokens`): 8k no relatório, 4k no chat/explicação, ~3x o
      maior valor medido; a entrada já era limitada (`REVIEW_BUDGET`,
      tamanho da pergunta). É um teto "macio": chamadas já em andamento
      podem ultrapassá-lo, limitadas pelo teto por chamada e pelos rate
      limits. Recalibrar com os dados reais da `llm_calls`.
- [x] Kill switch (flag) para desligar chat ou relatório por LLM sem deploy.
      Feito: tabela `llm_switches` (migração 0005), uma linha por função
      (`report`, `chat`, `explain`); sem linha = ligado. Lida a cada
      chamada, sem cache (variável de ambiente exigiria deploy, TD-36).
      Chat e explicação respondem 503 antes do rate limit; o relatório falha
      com mensagem de indisponível, com a base de conhecimento já montada.
      Como ligar e desligar: [runbook](runbooks/llm-kill-switch.md).
- [x] Fechamento: [architecture.md](architecture.md) com a seção de
      observabilidade e custo do LLM, e [retros/phase-4.md](retros/phase-4.md)
      (a escrever pelo autor). Falta ler em produção os números que o
      [baseline §5](baseline.md) deixou para esta fase (tokens e custo por
      relatório/chat, latência do chat, cold start, tempo por etapa).

**Se sobrar**

- [ ] Health check e runbooks: "Groq fora", "projeto travado", "webhook do
      Stripe falhando".
- [ ] Alerta de gasto diário do LLM.

## Fase 5 — Ingestão assíncrona

**Obrigatório**

- [x] ADR do job runner: Inngest × Vercel Workflow × fila no Postgres + cron.
      Critérios: retry com backoff, idempotência por step, timeout, custo,
      rodar local. Progresso: [ADR-005](decisions/005-job-runner.md)
      proposto (Vercel Workflows) e spike feito em 2026-10-02 — 7 de 12
      funções, ONNX e retry funcionam num step. Pré-condições: funções com
      ONNX no limite de 250 MiB — resolvido (TD-41: só o runtime de CPU,
      `analyze` 247,8 → 34,1 MiB); alertas de dependência do `workflow` —
      resolvidos com `overrides` na mesma major (`npm audit` limpo).
      **Aceito em 2026-10-03.**
- [x] Pipeline em steps idempotentes: `ImportRequested → Extract → Filter →
      Chunk → Embed → Index → ProjectIndexed`, com `content_hash` para não
      reprocessar (TD-03). Domain events gravados via outbox na mesma
      transação do estado. O mesmo hash reaproveita os achados do LLM quando
      o código revisado não mudou: hoje o mesmo ZIP reanalisado muda de nota
      (TD-43).
      Progresso: análise em steps idempotentes (PR #95); revisão do LLM
      reaproveitada por hash (TD-43); importação e reanálise do **GitHub**
      no workflow (step que baixa, extrai e grava, com retry); **upload de
      ZIP** no workflow pelo Neon Object Storage (ADR-011: navegador → bucket
      por POST assinado, step lê, extrai, grava e apaga; até 100 MB).
      `content_hash` + `embedding_model` nos chunks (TD-03, migração 0008):
      reconstrução reaproveita os vetores do conteúdo que não mudou;
      reanalisar código igual não gera nenhum embedding. Outbox: o próprio
      projeto (ADR-005), sem tabela de eventos enquanto o job é o único
      consumidor.
- [x] Progresso vindo do job; sai a lógica de claim/stale da rota `analyze`;
      reaper para projetos travados (TD-10, TD-11).
      Progresso: a **análise** roda como Vercel Workflow (PR #95): a rota
      só faz o claim e dispara o run, steps com retry e `FatalError`, run
      que morre termina `failed`, `flow` com 36,0 MiB. `runId` no projeto
      (migração 0007): a rota pergunta ao Workflow se o run está vivo, em
      vez de adivinhar pela janela de 360 s — run vivo não é disparado de
      novo mesmo depois de 360 s, run morto libera na hora. O claim atômico
      fica (protege contra duas abas); a janela fica só para projeto sem
      run (importação) ou run que o Workflow não acha mais. Reaper (TD-11):
      cron diário que marca como falha o projeto parado em `processing` há
      mais de 1 h, exceto run vivo no Workflow. Importação no job (TD-10):
      GitHub (PR #106) e ZIP via object storage (ADR-011, PR #112).
- [x] Parsing fora da thread da request (TD-09); modelo de embeddings com
      retry e cache resolvidos (TD-01; TD-05 com ADR).
      Progresso: parsing da análise num step do workflow (TD-09 parcial,
      PR #95); TD-01 feito (carga com retry e falha que não fica em cache).
      [ADR-006](decisions/006-embeddings-runtime.md) aceito com números
      de produção: modelo local na CPU (cold start 1,2 s; embedding ~44 s
      por análise; reanálise sem mudança reaproveita tudo, TD-03). Medição
      de chunks: projeto com mais de ~800 arquivos estouraria os 300 s de um
      step; o embedding agora roda em lotes de 1.000 chunks por step, com a
      troca do conhecimento no fim (TD-46, migração 0009).
- [x] **Degradação graciosa:** com o LLM fora ou sem cota, o relatório sai só
      determinístico, sinalizado como tal. Feito: kill switch desligado,
      orçamento diário de tokens gasto ou provedor falhando na **última**
      tentativa do step → o relatório sai com métricas e regras, sem
      achados nem resumos do LLM, e grava o motivo (`aiReviewSkipped` em
      `category_scores`, sem migração). Tentativas anteriores ainda sobem o
      erro (o workflow tenta de novo). Nada de revisão é guardado, então a
      próxima análise pede a revisão completa. O relatório (do dono e o
      link público) mostra "Automated checks only" com o motivo.
- [x] Webhooks do Stripe deduplicados pelo `event.id`. Feito de outro
      jeito, que cobre mais: todo evento que muda o plano busca o estado
      **atual** da assinatura no Stripe, então duplicatas **e** entregas
      atrasadas convergem para o estado real, sem tabela de eventos. Os
      eventos de assinatura já faziam isso (TD-37); o
      `checkout.session.completed` concedia premium pelo próprio evento, e
      uma reentrega depois de um cancelamento devolvia o premium (teste que
      falhava antes da correção). Dedupe por `event.id` barraria a
      duplicata, não a primeira entrega atrasada.
- [x] Fechamento: [results-phase-5.md](results-phase-5.md) (antes × depois
      com data e método, tempos de produção, incidentes),
      [architecture.md](architecture.md) e
      [retros/phase-5.md](retros/phase-5.md) (a escrever pelo autor). Não
      medido: duração total da análise antes × depois e um projeto real
      perto de 1.000 arquivos.

## Fase 6 — Segurança e dados

**Obrigatório**

- [ ] GitHub App com `contents: read`, instalação por repositório e tokens de
      curta duração (TD-15, ADR). Remove o escopo `repo` de escrita.
- [x] CSP com nonce, começando em `Report-Only` (TD-34). O proxy gera um
      nonce por request e manda a política em `Report-Only`; violações vão
      para o Sentry. O E2E falha com qualquer violação nas páginas públicas
      e no fluxo principal. Passar para `Content-Security-Policy` depois de
      ler os relatórios (TD-34).
- [x] Retenção: `project_files` e `code_chunks` apagados após N dias sem uso.
      N = 90 (`CODE_RETENTION_DAYS`). "Uso" = abrir o projeto (gravado no
      máximo 1×/dia, depois da resposta) ou importar o código. O cron diário
      apaga arquivos, chunks e `embedding_cache`; o projeto e o relatório
      ficam (`code_removed_at`). GitHub volta com "Analyze again"; ZIP, com
      novo upload. Migração 0010 (`last_used_at`, `code_removed_at`).
- [x] Exclusão de conta de ponta a ponta: cascade + cancelamento no Stripe +
      teste provando que nada sobra (LGPD). Em Settings, digitando o email
      (conferido no servidor). Ordem: apaga o customer no Stripe (assinatura
      termina na hora; se falhar, nada é apagado) → uploads pendentes no
      bucket → numa transação, `verification_tokens` do email e o usuário
      (o resto em cascata). O teste procura o id, o email, o customer e o
      projeto em **todas** as tabelas do schema e não acha nada. Rate limits
      guardam só SHA-256 da chave. Fica: JWT em outros dispositivos até
      expirar (TD-18): não vê dados e não cria nada (só um upload de ZIP
      que nunca é importado e o reaper apaga).
- [x] Página de dados: o que vai para o Groq, por quanto tempo e onde fica
      guardado. Pública em `/data` (link no rodapé e em Settings); os números
      vêm das mesmas constantes do código. Achado: o código vai ao Groq sem
      redação de segredos (TD-47).

**Se sobrar**

- [ ] Sessões revogáveis (TD-18, ADR) e rotação de chave de criptografia
      (TD-19).
- [ ] RLS com role da aplicação que não é dona das tabelas + políticas por
      `userId` (TD-21).
- [ ] Rate limiter: contar só logins com falha, limpar linhas antigas por
      cron (TD-17).
- [ ] Treino de restore (PITR do Neon num branch, tempo medido e documentado).
- [ ] Modelo de ameaças STRIDE e `SECURITY.md`.

## Fase 7 — Evals + qualidade da análise

> Executada logo depois da Fase 3 (ver "Ordem de execução" no início).
> **Concluída em 2026-09-30** (PRs a partir do #55): todos os itens obrigatórios.
> Principal conclusão medida: o modelo encontra o que recebe (revisão:
> toda vulnerabilidade enviada foi achada; chat: citações válidas 1,00 e
> abstém quando não há resposta); o limite é o que chega a ele (amostra da
> revisão e retrieval do chat nos repositórios grandes). Próximas: Fases 4,
> 5 e 6. Os itens "Se sobrar" e as alavancas do retrieval ficam para depois.

**Primeiro o harness, depois as melhorias**, sempre comparando com o baseline.

**Obrigatório**

- [x] `evals/` com dataset versionado: este repo, OWASP Juice Shop e 2 ou 3
      repositórios pequenos com violações conhecidas e anotadas, mais casos
      de prompt injection (TD-28).
      Progresso: OWASP NodeGoat (commit fixo, lido como importação do
      GitHub, baixado para `evals/.cache`), 9 vulnerabilidades ativas
      anotadas por arquivo e linha. Baseline determinístico: 50 arquivos,
      286 chunks, 7 achados (1 falso positivo: "Large file" num arquivo de
      terceiros em `app/assets/vendor/`); só **2 de 9** linhas vulneráveis
      entram na amostra do revisor. Causas: bibliotecas de terceiros
      (`vendor/`, `*.min.js`) ocupam 3 vagas, e o amostrador pega só o
      primeiro chunk de cada arquivo, enquanto o NodeGoat escreve cada
      arquivo como uma função grande. Eval do LLM do NodeGoat pendente: a
      cota diária do Groq (200 mil tokens por organização) acabou nas
      rodadas de hoje. Próximos PRs, cada um com antes × depois: excluir
      código de terceiros; escolher dentro do arquivo os chunks que tocam
      entrada ou chamadas perigosas. Falta: Juice Shop e outros.
      ✅ Código de terceiros excluído (`third_party/`, `third-party/`,
      `bower_components/`, `*.min.js`, e `vendor/` só na raiz ou dentro de
      `assets/`/`public/`/`static/`, porque em `src/modules/vendor/` é
      palavra de domínio): NodeGoat 50 → 44
      arquivos, 286 → 93 chunks (−67% de embeddings e armazenamento), 7 → 6
      achados (sai o falso positivo); linhas na amostra seguem 2/9 (a causa
      principal é a escolha dentro do arquivo, próximo PR).
      ✅ Dentro de cada arquivo, os chunks com mais sinais de risco primeiro
      (entrada não confiável, chamadas perigosas, autenticação/sessão:
      categorias genéricas do OWASP para JS/TS, não as linhas do NodeGoat),
      depois por linha; o primeiro chunk costuma ser só os imports.
      NodeGoat: linhas vulneráveis na amostra 2/9 → **4/9**. Custo medido:
      chunks arriscados são maiores, então cabem menos arquivos no mesmo
      orçamento (este repo 24 → 18 arquivos; saem, entre outros,
      `checkout.ts` e `drizzle-project-queries.ts`, entra `db.ts`). No
      NodeGoat faltam os DAOs (`app/data/`): os chunks das rotas esgotam o
      orçamento antes. Próxima alavanca: ordenar também os arquivos por
      risco, ou enviar só o trecho arriscado de chunks grandes. Eval do LLM
      pendente da cota do Groq.
      ✅ Arquivos com sinal de risco antes dos sem nenhum (respeitando a
      prioridade por caminho entre eles), o mais arriscado primeiro:
      NodeGoat 4/9 → **5/9** (entra `user-dao.js`, senhas em texto puro).
      Este repo mostrou um viés dos sinais: só conheciam Express e SQL cru,
      e consulta via ORM (Drizzle/Prisma), NextAuth e `process.env`
      pontuavam zero, então `proxy.ts` e os repositórios saíam da amostra.
      Sinais ampliados com acesso a dados via ORM, bibliotecas de
      autenticação e segredos/configuração (categorias do OWASP para
      qualquer stack): NodeGoat segue 5/9; este repo 17 arquivos, com
      `proxy.ts`, `auth.ts`, rotas de API, webhook e checkout. Faltam no
      NodeGoat os outros DAOs, a regex do ReDoS e o `autoescape`, por
      orçamento. Próximo passo: o eval do LLM, para saber se o recall
      acompanha a amostra, antes de mexer mais nela.
      OWASP Juice Shop (TypeScript, Express + Angular) no dataset: a
      resposta vem dos marcadores `vuln-code-snippet vuln-line` do próprio
      projeto (8 arquivos), removidos antes da análise porque nomeiam a
      falha. O importador rejeitava o Juice Shop (1.163 arquivos de texto
      contra o limite de 1.000): o limite passou a contar só os arquivos
      JS/TS, os únicos lidos, analisados e guardados (640 no Juice Shop).
      Baseline: 633 arquivos, 2.031 chunks, 24 achados; só **1 de 8**
      arquivos vulneráveis na amostra do revisor. Causa: componentes do
      frontend Angular (`payment.component.ts`, `two-factor-auth-...`)
      ganham prioridade de servidor pelo nome do caminho e têm muitos
      sinais, e tiram a vaga das rotas do backend. Próximo PR: UI
      (`*.component.ts`, `frontend/`, `client/`) não ganha prioridade de
      servidor pelo nome. A medir em produção: se a ingestão de 2 mil
      chunks cabe nos 300 s da Vercel.
      ✅ Código do navegador sem prioridade de servidor pelo nome
      (componentes Angular `*.component.ts`, pasta `frontend/` ou `client/`
      na raiz): Juice Shop 1/8 → **2/8** (entra `routes/login.ts`, SQL
      injection no login); NodeGoat e este repo sem mudança. Arquivos em
      `static/`, `public/` ou `assets/` também (servidos ou dados, não
      código do servidor): o número não mudou (2/8), mas as variantes de
      `data/static/codefixes/` saíram e a amostra ficou só com backend. O
      limite agora é estrutural: ~60 rotas no Juice Shop, cabem 13 no
      orçamento de 16 mil caracteres. Avançar pede mais orçamento por
      análise (várias chamadas em lotes ou outro provedor, ADR-011),
      decisão de custo/cota a tomar depois do eval do LLM.
      ✅ **Eval do LLM nos repositórios reais** (`d7c5284`, conta Groq só
      de evals, 3 execuções por caso, 0 falhas em 21 chamadas): casos
      sintéticos com todos os problemas encontrados; NodeGoat 6–7 de 9
      (recall 0,74); Juice Shop 1–2 de 8 (0,17). Toda vulnerabilidade que
      chegou ao modelo foi encontrada (NodeGoat 5 de 5; `login.ts` do Juice
      Shop 3 de 3): **o gargalo é a amostra, não o modelo nem o prompt.**
      **Dataset fechado** com este repo, NodeGoat, Juice Shop, os casos
      sintéticos e os de injeção de prompt: os "2 ou 3 repositórios
      pequenos" ficam cobertos pelo NodeGoat e pelos casos sintéticos (um
      terceiro repositório real custaria cota e tempo de CI sem trazer um
      tipo de caso novo).
- [x] `npm run eval` → `evals/results/<data>.json`: precisão/recall dos
      achados, falsos positivos, groundedness do chat, recall do retrieval,
      latência, tokens e custo.
      Progresso: harness da análise determinística (casos anotados + este
      repo lido como importação do GitHub). **Baseline da Fase 7**
      (2026-09-30, `a853a30`): precisão 0,67, recall 1,00, 3 falsos
      positivos (componente React por linhas, `oauth-icons` como área
      crítica, texto de UI com "token"); este repo: 22 achados, Code
      Quality 0 e Testing 0. Eval do LLM (opt-in, 3 execuções por caso):
      baseline `bf17f41` — recall 1,00 (inclusive com injeção de prompt),
      evidência 0,97, estabilidade 0,44–0,63, 6–8 achados em projetos de 2–3
      arquivos. Retrieval do chat: 21 perguntas (NodeGoat, Juice Shop, este
      repo) escritas antes da primeira medição, com os arquivos que as
      respondem; mesmo chunking e modelo de embedding da produção, busca
      exata como o pgvector sem índice. Baseline `18b11ed`: recall@8 0,57
      (NodeGoat 1,00; Juice Shop 0,29; este repo 0,43), hit@1 0,24, MRR
      0,34, com gate no CI. No Juice Shop, as variantes de
      `data/static/codefixes/` (cópias quase idênticas do código) e os
      tutoriais tomam as primeiras posições; neste repo, conceitos vizinhos
      disputam a vaga (`finding.ts` × `evidence.ts`). Próximas alavancas,
      cada uma com antes × depois: remover chunks quase duplicados, dar
      menos peso a arquivos servidos/dados, busca híbrida (palavra-chave +
      embedding). ✅ **Groundedness do chat** (`c75ebff`): o chat como a
      produção roda, 3 perguntas + 1 sem resposta (assunto ausente,
      conferido por busca) por repositório, checagens determinísticas sem
      um segundo modelo. Citações válidas 1,00 nos 3 repositórios (nenhum
      arquivo do projeto citado sem ter sido recebido); diz que não sabe nas
      3 perguntas sem resposta; cita o arquivo certo quando ele foi
      recuperado (NodeGoat 2 de 3, este repo 2 de 2; no Juice Shop ele não
      foi recuperado). Ler as respostas uma a uma achou 3 erros da própria
      medição, corrigidos com as frases reais como teste (hífen U+2011 nos
      nomes de arquivo, apóstrofo tipográfico, sugestão de arquivo contada
      como citação) e a pasta `evals/` tirada do corpus deste repo (contém
      as perguntas). Custo: tokens por chamada no resultado; US$ 0 no plano
      gratuito, numa conta Groq só para evals.
- [x] Prompts em arquivos versionados; PR que altera prompt ou retrieval roda
      o eval e falha se a qualidade cair.
      Progresso: os 3 prompts em módulos próprios (`analysis/domain/
      review-prompt.ts`, `chat/domain/prompt.ts`, `chat/domain/
      explain-prompt.ts`), o texto enviado provado idêntico por snapshot
      antes × depois; versão = hash do texto fixo. `evals/prompts.lock.json`
      registra a versão de cada prompt e o resultado de eval que a mediu, e
      o CI falha se um prompt muda sem o lock (o CI não tem chave do LLM,
      então não roda o eval do prompt ele mesmo). Retrieval: o eval roda no
      CI com gate. ✅ Workflow **LLM eval**: quando um PR do próprio
      repositório muda a análise, o prompt, o modelo ou o eval, roda a
      revisão com o modelo real (secret `GROQ_EVAL_API_KEY`, conta separada:
      o eval nunca usa a chave de produção) e falha abaixo do baseline
      (sintéticos todos, NodeGoat 6 de 9, Juice Shop 1 de 8) ou com citação
      de arquivo não recebido.
- [x] **Dogfooding:** o analisador roda no próprio repo a cada PR e publica
      score e achados; gráfico do score ao longo das fases no README.
      Progresso: job `eval` no CI (parte determinística, sem LLM, sem custo
      nem segredo) analisa este repo e o NodeGoat a cada PR, publica os
      números no resumo do job e falha se a qualidade cair: precisão e
      recall dos casos anotados ≥ 1,00 e linhas vulneráveis do NodeGoat na
      amostra ≥ 5/9 (limites só sobem). ✅ Gráfico no README
      (`npm run eval:chart` → `docs/assets/dogfooding.svg`): a nota
      determinística deste repo em cada resultado versionado, 53 → 69, com a
      mesma medida na fórmula v1 tracejada para separar o efeito da fórmula
      (ADR-010) do efeito das correções da análise. Antes da Fase 7 não há medida comparável (a nota 30 do baseline é
      de um relatório completo, com as categorias do LLM): ela é citada no
      texto, não plotada.
- [x] Melhorias, cada uma num PR com eval antes × depois:
  1. ✅ Excluir `.claude` e outras pastas de ferramenta/docs em
     `ALWAYS_EXCLUDE_DIR_NAMES` (`src/lib/limits.ts`). Feito: pastas de
     editor/agente (`.claude`, `.cursor`, `.vscode`, `.idea`, `.husky`) e
     saída gerada de outros frameworks e ferramentas (`.nuxt`, `.output`,
     `.svelte-kit`, `.docusaurus`, `.expo`, `.cache`, `.parcel-cache`,
     `.yarn`). `docs/`, `out/` e `.github` ficam, porque podem ter código
     real. Neste repo não muda nada (`.claude` só tem `.md`); o ganho é
     em repositórios importados.
  2. ✅ Amostrar chunks do projeto inteiro no relatório, em vez dos 80 primeiros
     em ordem alfabética (`report.ts`). Feito: `sampleForReview` (puro, no
     módulo analysis) tira os testes, põe lógica de servidor primeiro
     (API, rotas, actions, auth, db...), depois outra lógica, UI e
     configuração/tipos, e alterna uma pasta por vez, no mesmo orçamento
     (16 mil caracteres, 24 chunks). Neste repo, o revisor via 14 chunks
     de 5 arquivos em 3 pastas (config, specs E2E e evals, nenhum código da
     aplicação) → 24 chunks de 24 arquivos em 24 pastas (rotas de API,
     auth, webhook do Stripe, actions, módulos), 0 testes. Eval do LLM, 2
     casos novos com o arquivo problemático atrás de 30 arquivos que vêm
     antes na ordem alfabética: arquivo enviado 0/1 → 1/1, recall 0 → 1,00
     nas 3 execuções; casos antigos seguem com recall 1,00. Custo: com a
     amostra cheia, ~5,5 mil tokens de entrada e 15–30 s por chamada
     (dentro do timeout de 120 s e do limite por minuto do Groq).
  3. ✅ Agrupar achados repetidos (uma linha "Critical area may lack tests" com a
     lista de arquivos).
  4. ✅ Score com penalidade limitada por regra ou decrescente
     (`scoreFromIssues`). Feito com o 3 na
     [ADR-010](decisions/010-score-formula.md): Code Quality 0 → 45, Testing
     0 → 10, nota determinística 53 → 64, 22 → 4 linhas no relatório.
  5. ✅ Achados high/critical exigem arquivo + trecho como evidência; prompt mais
     restritivo; código tratado como dado, não como instrução (TD-28).
     Feito: o LLM cita a linha de código de cada achado e `verifyEvidence`
     (determinístico, sem um segundo modelo) descarta o que não está no
     arquivo citado; achado sem arquivo fica no máximo "medium";
     temperatura 0; prompt pede poucos achados precisos, sem afirmar o que
     falta no projeto a partir de uma amostra. Eval do LLM `bf17f41` →
     depois: recall 1,00 → 1,00 (inclusive com injeção de prompt),
     evidência 0,97 → 1,00, estabilidade 0,44–0,63 → 0,78–0,83, achados
     6,0–8,3 → 3,3–3,7 por caso. A citação de várias linhas fez o modelo
     gerar JSON inválido (Groq `json_validate_failed`, 2 de 9 chamadas):
     citação de uma linha + 1 nova tentativa só para esse erro → 0 de 9.
  6. ✅ Heurísticas determinísticas: não medir componentes React só por
     linhas, critério melhor para "área crítica". Feito: componente medido
     pela lógica até o último `return` de JSX; "área crítica" = arquivo de
     lógica (não tela) com a palavra inteira no caminho; arquivo importado
     por um teste conta como testado (`@/` e relativo); valor com espaço
     não é segredo. Eval: precisão 0,57 → 1,00 com recall 1,00 (casos
     ampliados com problemas reais que não podem sumir); este repo 22 → 17
     achados, nota determinística 64 → 68. Limite conhecido: teste
     indireto (via `server.ts`) só com o grafo de imports (v2.1). (As correções objetivas —
     regex do TD-31, `src/test/`, segredos em fixtures — foram antecipadas
     para a Fase 3.)
  7. Timeout e limites aplicados no servidor (TD-29, ✅ feito com o 5:
     timeout de 120 s, no máximo 10 achados e textos com tamanho máximo);
     migrar para `generateText` + `Output.object` (TD-30, ✅ feito, sem
     mudar o pedido ao provedor).

**Se sobrar**

- [ ] Chunk no tamanho real do tokenizer (TD-02), sem duplicar métodos de
      classe (TD-08), modelo de embedding gravado junto do vetor (TD-03).
- [ ] Índice HNSW no `embedding` (TD-22), latência medida antes e depois.
- [ ] Achados classificados com CWE / OWASP (ASVS, Top 10 for LLM).

## Encerramento da v2.0

- [ ] Remover as classes `ca-*` sem uso do `globals.css`.
- [ ] README como estudo de caso: problema, arquitetura (C4), antes × depois
      medido, gráfico do dogfooding, links para as ADRs.
- [x] Relatório de demonstração publicado pelo **link público** (Fase 3) e
      linkado no README: quem avalia não precisa criar conta, conectar o
      GitHub nem esperar uma análise.
- [ ] **Postmortems** dos incidentes reais, escritos pelo autor, em
      `docs/postmortems/` (linha do tempo, causa raiz, impacto, correção, o
      que mudou para não repetir): análise quebrada em produção desde o
      primeiro deploy (ONNX na Vercel), variáveis de produção apagadas ao
      separar ambientes (TD-36), cancelamento que mantinha o premium (TD-37).
- [ ] Vídeo de 2 a 3 minutos do fluxo principal.
- [ ] Artigo técnico (ex.: "por que o meu analisador deu 0 para o próprio
      código").
- [ ] Decisões pendentes respondidas (ver abaixo).
- [ ] Tag `v2.0.0`.

### Renomear para `nextjs-codedriven`

Já feito: repositório do GitHub, `package.json`, projeto no Neon e nome do
projeto na Vercel.

1. [x] **Domínio de produção:** `https://nextjs-codedriven.vercel.app`
       (2026-09-29). O antigo `nextjs-code-analyzer.vercel.app` continua
       ligado ao projeto como **redirect 308** preservando o caminho (não foi
       removido, para os links antigos funcionarem e o nome não ficar livre
       para terceiros). Atualizados: `AUTH_URL` e `NEXT_PUBLIC_APP_URL` de
       Production, callback do GitHub OAuth App (só o domínio, cobre
       `/api/auth/callback/github` e `/api/github/callback`), redirect URI
       do Google OAuth, URL do webhook do Stripe. Limpeza pendente: URIs
       antigas no Google.
2. [x] `<title>` da página como **codedriven · AI Codebase Auditor** (a landing mantém "AI Codebase Auditor"), README e User-Agent do GitHub como codedriven, e comentários "Code Analyzer"/"Kudos" removidos em
       `globals.css`, `ui/button.tsx` e `ui/select.tsx`. O `CLAUDE.md` e o
       README mantêm a referência ao tutorial original `AI-Code-Analyzer`.
3. [ ] **Por último**, a pasta local `nextjs-code-analyzer` →
       `nextjs-codedriven` (fechar o VS Code antes). O histórico do Claude
       Code é por caminho de pasta: a pasta nova começa uma sessão nova.
4. [x] Nome: **codedriven** no título, README e repositório; "AI Codebase Auditor" segue como descrição na landing.

---

## Arquitetura: o que entra e o que fica de fora

### Entra

| Conceito | Onde neste projeto | Fase |
|---|---|---|
| Monólito modular | `src/modules/*`, cada um com API pública no `index.ts` | 3 |
| DDD estratégico | Bounded contexts = módulos; `docs/glossary.md`; context map (billing só expõe "tem cota?" para projects) | 3 |
| DDD tático | Aggregates `Project` (máquina de estados `queued → processing → completed/failed`) e `Subscription`; value objects `SafeFilePath`, `RepoRef`, `Score`, `Plan`; repositórios por aggregate | 3 |
| Clean / Hexagonal | Portas `LlmProvider`, `Embedder`, `VectorStore`, `SourceProvider`; adaptadores Groq, xenova, pgvector, GitHub/ZIP (depois Ollama e pasta local) | 3, v2.2 |
| SOLID | Principalmente DIP (use case depende da porta) e SRP (rota fina, use case, adaptador) | 3 |
| CQRS leve | Commands = use cases que alteram estado; queries = leituras para as pages. Mesmo banco | 3 |
| Event-driven | Domain events (`ProjectImported`, `AnalysisCompleted`) em processo, depois gatilho de jobs duráveis | 3 → 5 |
| Outbox / idempotência | Evento gravado na mesma transação do estado; webhooks deduplicados | 5 |
| Resiliência | Timeout em toda chamada externa, retry com backoff, reaper, degradação graciosa | 5 |
| Observabilidade | Logs estruturados, correlation id, tracing, métricas de LLM (tokens, custo, latência), Sentry | 4 |
| Segurança como arquitetura | Defesa em profundidade, menor privilégio, código analisado tratado como dado não confiável | 6 |
| Fitness functions | Regras de camada e de módulo no CI (`dependency-cruiser`) | 3 |
| Arquitetura de testes | Domínio em unit puro; use cases com fakes das portas; adaptadores em integração; E2E do fluxo principal | 2, 3 |
| Arquitetura de IA | Pipeline RAG em estágios, evals versionados, eval no CI | 7 |
| Decisões documentadas | ADRs com opções rejeitadas; C4 nível 1 e 2 | Todas |

### Fica de fora

| Não usar | Motivo |
|---|---|
| Microsserviços | Um desenvolvedor, um deploy; módulos com fronteira limpa são fáceis de extrair se um dia precisar |
| Kafka / RabbitMQ | O job runner cobre o volume e é mais simples de operar |
| Event sourcing | Nenhum requisito de auditoria ou reconstrução de estado que justifique o custo |
| CQRS com banco de leitura separado | Um Postgres atende; o CQRS leve basta |
| Container de DI | Funções factory no `index.ts` resolvem sem mágica |
| Micro-frontends | Um app só |
| DDD tático em tudo | CRUD simples e a integração com NextAuth ficam diretos |

---

## Front e estado

### Componentização

- Dividir quando o componente tem mais de um motivo para mudar, mistura
  efeitos/fetch com markup, ou é reutilizado. **Não** dividir por número de
  linhas.
- Lógica em hooks, visual em componentes: `useAnalysisProgress` sai de
  `analysis-progress.tsx` (319 linhas, 3 `useEffect`, polling, retry).
- Pages longas viram seções server component que recebem dados prontos
  (`report/page.tsx`: `ScoreOverview`, `CategoryCards`, `RoadmapList`).
- A landing (`src/app/page.tsx`) só é dividida quando for alterada.
- Pastas: `ui/` (só shadcn), `shared/` (reuso entre telas), `<feature>/`
  (mesmos nomes dos módulos). Sem atomic design, sem abstrações headless
  genéricas.

### Estado

| Tipo | Onde mora | Mudança na v2 |
|---|---|---|
| Dados do servidor | Server Components chamando queries dos módulos | Sai o Drizzle das pages |
| Mutações | Server actions + `useActionState` (já usado) | Action vira adaptador fino do use case |
| Invalidação | `revalidatePath` | Centralizada por módulo; Cache Components só se o baseline pedir, com `userId` na tag |
| Filtros e seleção | `searchParams` | Filtros do issues dashboard saem do `useState` |
| Processo longo | Hook `useAnalysisProgress` | Na Fase 5, consome o progresso do job |
| Streaming de IA | `useChat` (já usado) | Mantém; histórico persistido no servidor |
| Fetch sob demanda | Hook por caso de uso | `AbortController` quando a seleção muda |
| Visual | `useState` local | Mantém |

**Fica de fora:** Zustand/Redux/Jotai (não há estado de cliente
compartilhado), React Query/SWR (seria um segundo cache concorrendo com o
RSC), Context global para usuário/plano (regras validadas no servidor).
Qualquer biblioteca nova de estado exige ADR.

---

## Backlog v2.x / v3

Fora do escopo da v2.0. A ordem pode mudar conforme as decisões pendentes e
os evals.

- **v2.1 — Code Intelligence:** AST do repositório inteiro (símbolos,
  imports/exports, grafo de dependências; TD-07), métricas pela AST (TD-31),
  ferramentas determinísticas com licença verificada (`dependency-cruiser`,
  `jscpd`, `knip`, `gitleaks`, `osv-scanner`; **não** usar regras do Semgrep
  Registry nem CodeQL num SaaS sem checar a licença), LLM explicando
  evidências (arquivo + linha), busca híbrida e citações se o eval mostrar
  ganho.
- **v2.2 — Primeiras análises + modo local:** violações de camada e ciclos,
  hotspots (churn × complexidade), autorização e multi-tenancy, segurança de
  IA, qualidade dos testes, cada uma com eval. CLI via `npx` com Ollama,
  pasta local e pgvector em Docker; zero telemetria com código.
- **v2.3 — Agents, tools e regras do time:** tools sobre a Code Intelligence
  (`search_code`, `get_file`, `find_symbol`, `find_dependencies`,
  `inspect_call_graph`), chat como agente, servidor MCP, gateway de LLM só
  com 2+ providers reais, regras de arquitetura do time verificadas por PR.
- **Reanálise por push (depois das Fases 5 e 6):** webhook assinado do GitHub
  App → job → reanálise incremental só dos arquivos alterados (usa o
  `content_hash` da Fase 5).
- **v3+ — Produção e produto:** teste de carga, pool de conexões, lote de
  embeddings, arquivos em object storage (TD-06, TD-13, TD-23), SLOs,
  postmortems, validação do nicho.

---

## Decisões pendentes (prazo: fim da v2.0)

Mudam o roadmap a partir da v2.2.

| Pergunta | Impacto |
|---|---|
| Portfólio, produto ou os dois? | Quanto investir em billing, onboarding e suporte |
| Open source (CLI) + SaaS, ou só SaaS? | Licença do repo e ferramentas que podem ser integradas |
| Due diligence técnica é o nicho? Com quem conversar primeiro? | Quais análises priorizar na v2.2 |
| Quantas horas por semana? | Estimativas de cada fase |

---

## ADRs previstas (`docs/decisions/`)

| # | Decisão | Fase |
|---|---|---|
| 001 | [Monólito modular + Clean Architecture seletiva](decisions/001-modular-monolith.md) — aceita | 3 |
| 002 | [Convenção dos módulos e regras de arquitetura no CI](decisions/002-module-convention.md) (`dependency-cruiser`) — aceita | 3 |
| 003 | [Regras da cota](decisions/003-quota.md), inclusive falha do sistema × erro do usuário (TD-12) — proposta | 3 |
| 004 | Limites de custo do LLM e kill switch | 4 |
| 005 | [Job runner da ingestão + outbox](decisions/005-job-runner.md) — aceita | 5 |
| 006 | [Embeddings em runtime serverless](decisions/006-embeddings-runtime.md) (TD-05, TD-46) — aceita | 5 |
| 007 | [GitHub App no lugar do OAuth App](decisions/007-github-app.md) (TD-15, TD-16) — proposta, spike aprovado | 6 |
| 008 | Retenção e exclusão de dados | 6 |
| 009 | Estratégia de evals e gate no CI | 7 |
| 010 | Fórmula do score (penalidade com teto) | 7 |
| 011 | [Onde o ZIP enviado fica até o job processá-lo](decisions/011-zip-upload-storage.md) (TD-45) — aceita | 5 |

Formato: contexto, problema, opções (inclusive as rejeitadas), decisão,
trade-offs, consequências.

## TD → fase

| Fase | TDs |
|---|---|
| 2 — Rede de segurança | TD-25, TD-27 |
| 3 — Clean Architecture | TD-04, TD-12, TD-14, TD-16, TD-20, TD-24, TD-32, TD-33 |
| 4 — Observabilidade | TD-26 |
| 5 — Ingestão assíncrona | TD-01, TD-03 (hash), TD-05, TD-09, TD-10, TD-11 |
| 6 — Segurança | TD-15, TD-34 · se sobrar: TD-17, TD-18, TD-19, TD-21 |
| 7 — Evals + qualidade | TD-28, TD-29, TD-30, TD-31 · se sobrar: TD-02, TD-03, TD-08, TD-22 |
| v2.1 — Code Intelligence | TD-07, TD-31 (AST) |
| v3+ — Produção | TD-06, TD-13, TD-23 |

## Diferenças em relação ao roadmap original de 18 fases

- **Observabilidade sobe** para antes da ingestão assíncrona.
- **Evals vêm antes de qualquer mudança em prompt ou RAG**, não depois do
  gateway de LLM.
- **Gateway, MCP e performance esperam necessidade real** (YAGNI).
- **ADRs são escritas durante as fases**, não numa fase própria no fim.
- **`domain/application/infrastructure` só nos módulos com regra de negócio.**
- **Escopo com linha de corte** e critérios de saída mensuráveis.
