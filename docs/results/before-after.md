# v2.0: antes × depois

Medido em 2026-10-04. O "antes" está em [baseline.md](../baseline.md).

A primeira análise deste repositório, feita pelo próprio analisador
(2026-09-29), deu **30/100**. Os números eram falsos:

- **Testing 0 com 169 testes no repositório.** A regra comparava nomes de
  arquivo, e `oauth-icons.tsx` virava "área crítica sem teste" só por conter
  `auth`.
- **Code Quality 0**, porque a penalidade linear não tinha teto.
- **Segurança 16** por um "segredo" que era um texto gerado num arquivo de
  teste.

Em vez de ajustar a nota até ela ficar bonita, a v2 tratou o analisador como
um produto que precisa provar o que diz:

| | Antes | Depois (2026-10-04) | Como foi medido |
|---|---|---|---|
| Nota determinística deste repositório | 53 (primeiro eval, 2026-09-30) | **78** | `npm run eval`, resultados versionados em [`evals/results/`](../../evals/results/) |
| Testing deste repositório | 0 (relatório de 2026-09-29) | **80** | Heurística calibrada contra a cobertura real do v8 ([ADR-010](../decisions/010-score-formula.md)): 66% medido, 63% real |
| Achados falsos do LLM | sem medição | casos proibidos no eval | O LLM eval roda o modelo real e falha se um falso positivo conhecido voltar |
| Testes | 43 unitários | **543 unitários, 180 de integração (Postgres real), 7 E2E** | Vitest e Playwright no CI |
| Onde a análise roda | dentro da request (até 300 s) | Vercel Workflow com retry por etapa | E2E na build de produção ([resultados da Fase 5](phase-5.md)) |
| Função com o runtime ONNX | 247,8 MiB (a 2,2 MiB do limite) | 36,0 MiB | Tamanho da função na Vercel |
| Embeddings de código sem mudança | todos de novo (~44 s) | reaproveitados por hash | Log de produção: 344 de 344 reaproveitados |
| Credenciais do usuário guardadas | token OAuth com acesso de escrita a todos os repositórios | **nenhuma**: GitHub App só de leitura, token de 1 h | [ADR-007](../decisions/007-github-app.md) |
