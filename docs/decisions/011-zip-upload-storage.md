# ADR-011 — Onde o ZIP enviado fica até o job processá-lo

- **Status:** proposta
- **Data:** 2026-10-03
- **Fase do roadmap:** 5 — Ingestão assíncrona (TD-10, TD-45)

## Contexto

- A importação e a reanálise do **GitHub** já rodam no workflow (ADR-005,
  PR #106): o step baixa o zipball pela rede. O **upload de ZIP** continua
  na request: a server action recebe o arquivo, extrai e grava (TD-10).
- **A Vercel limita o corpo da request de uma função a 4,5 MB** e responde
  `413 FUNCTION_PAYLOAD_TOO_LARGE` acima disso (docs "Functions Limits",
  lidas em 2026-10-03). O `serverActions.bodySizeLimit` de 110 MB não muda
  esse limite da plataforma. A interface e o servidor prometem 100 MB: em
  produção, todo ZIP acima de 4,5 MB falha antes de chegar ao código
  (TD-45).
- Um step do workflow só recebe ids (regra do ADR-005), e o Workflow limita
  payloads a 50 MB: os bytes do ZIP precisam estar guardados em algum lugar
  que o step leia.
- Os arquivos extraídos já ficam no Postgres (`project_files`, TD-13). O
  branch gratuito do Neon tem limite de 1 GiB de tamanho lógico.
- Restrições: custo zero, Hobby da Vercel, plano gratuito do Neon (projeto
  em `aws-us-east-1`).

## Problema

Como o ZIP sai do navegador e chega ao job, passando do limite de 4,5 MB,
sem guardar o código do usuário mais do que o necessário?

## Opções consideradas

1. **Neon Object Storage, upload direto do navegador por POST assinado.**
   A action (sessão, zod, cota) cria o projeto e devolve um POST assinado
   de curta duração para a chave `uploads/<userId>/<uuid>.zip`, com
   `content-length-range` até 100 MB; o navegador envia direto ao bucket
   privado; a action de confirmação dispara o workflow com o id do projeto;
   o step baixa pela chave, extrai, grava e **apaga o objeto**.
   - Prós: mesmo fornecedor do banco (sem conta nova); **ramifica com o
     banco** (o preview tem o próprio bucket, a produção não é tocada);
     5 GB grátis por projeto; S3 padrão (SDK da AWS, portável); POST
     assinado e CORS suportados; o tamanho é imposto pela assinatura, não
     pelo navegador.
   - Contras: regras de expiração **não rodam** no Neon — uploads
     abandonados precisam ser apagados por nós (o reaper diário, TD-11);
     dependências novas (`@aws-sdk/client-s3`, `@aws-sdk/s3-presigned-post`);
     credenciais S3 por ambiente na Vercel (Production ≠ Preview, TD-36);
     configuração de CORS para a origem do app.
2. **Vercel Blob, client upload** (`@vercel/blob/client` + rota que emite o
   token, com `maximumSizeInBytes`).
   - Prós: SDK simples e integrado; tamanho imposto no token; uploads sem
     custo de transferência.
   - Contras: Hobby com 1 GB e 2.000 operações avançadas por mês, e **ao
     estourar o Blob fica bloqueado por 30 dias**; não ramifica com o banco
     (preview e produção dividem o store, ou dois stores à mão); segundo
     lugar de armazenamento preso à Vercel.
3. **Upload em pedaços (< 4,5 MB) pelas funções, remontado no Postgres.**
   - Prós: nenhum serviço novo.
   - Contras: dezenas de requests por arquivo, `bytea` temporário de até
     100 MB no branch de 1 GiB, remontagem e limpeza nossas; mais código e
     mais pontos de falha do que as outras opções juntas.
4. **Limite honesto de 4 MB, sem job para ZIP.** A interface e o servidor
   passam a dizer 4 MB; repositórios maiores entram pelo GitHub.
   - Prós: quase nenhum código; corrige a promessa falsa já.
   - Contras: abre mão de ZIPs maiores; TD-10 fica aberto para ZIP (pequeno
     o bastante para a request, mas ainda fora do job).

## Decisão (proposta)

**Opção 4 agora, como correção imediata do TD-45, e opção 1 em seguida**,
condicionada a um spike no preview que prove: POST assinado do navegador
com CORS, limite de tamanho recusado pelo bucket, credenciais do branch
`preview` separadas das de produção, e o step lendo e apagando o objeto.

Motivo: o limite de 4,5 MB é uma falha de produção hoje e se resolve sem
decisão nova; o armazenamento de objetos é o único caminho que passa do
limite sem fornecedor novo, e o do Neon acompanha os branches do banco —
o mesmo isolamento entre preview e produção que o projeto já tem.

## Trade-offs e consequências

- **Regras obrigatórias (opção 1):**
  - bucket privado; chave com o `userId` da sessão e um uuid (nunca nome
    enviado pelo cliente); o step reconfere que a chave é do dono;
  - POST assinado com expiração curta (minutos), tamanho máximo e tipo
    fixos; o servidor nunca confia no tamanho declarado pelo navegador;
  - o objeto é apagado depois da extração, com sucesso ou falha; o reaper
    apaga uploads órfãos com mais de 1 h;
  - o ZIP nunca passa pelos dados do Workflow (só o id do projeto).
- **Fica pior:** um fluxo de upload em duas etapas no cliente (pedir a
  URL, enviar, confirmar), mais um conjunto de credenciais por ambiente.
- **Revisar se:** o Neon passar a aplicar regras de expiração (a limpeza
  manual sai); o volume passar dos 5 GB grátis; ou os arquivos extraídos
  saírem do Postgres (TD-13), que usaria o mesmo bucket.
