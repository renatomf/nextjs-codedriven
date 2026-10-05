# Retro — Fase 7 (evals + qualidade da análise)

- **Período:** 2026-09-30 (harness, PR #55) a 2026-09-30 (PR #76); ajustes
  de 2026-10-04 (PR #132) a 2026-10-05 (PR #136)
- **Estimado × real:** … (a tabela de planejamento do roadmap não tinha estimativa)
- **Números:** README (tabela "Antes × Depois"), ADR-010 e `evals/results/`

<!--
Fatos para ajudar a lembrar (apague depois de escrever):
- Ordem: harness determinístico e baseline (#55) → nota com achados
  agrupados (#56, ADR-010) → eval do LLM (#58) → evidência por linha (#59)
  → amostragem espalhada e por risco (#60, #67, #68) → NodeGoat e Juice
  Shop (#64, #70) → eval no CI com gate (#69) → retrieval do chat (#72) →
  prompts versionados com lock (#73) → gráfico do dogfooding (#74).
- Conclusão medida: o modelo acha o que recebe (toda vulnerabilidade
  enviada foi achada; chat com citações válidas 1,00 e abstenção quando não
  há resposta); o limite é o que chega a ele (amostra de ~16k caracteres;
  no começo só 2 de 9 linhas vulneráveis do NodeGoat entravam).
- Nota do próprio repositório: Code Quality 0 → 67 e Testing 0 → 16
  (2026-09-30); a heurística de testes (TD-31, #132) e a calibração contra a
  cobertura medida com v8 (estimativa 66%, real 63%; #133) levaram Testing
  a 57; testar as 4 áreas críticas (#135) levou a 80 em produção.
- Ajustes do prompt depois da fase, cada um com antes × depois no eval:
  erros de sintaxe em código válido (TD-48, #134) e escolhas de design
  reportadas como defeito (TD-49, #136: 3 achados proibidos → 0).
- Tropeços: a cota diária do Groq (200 mil tokens) acabou no meio de
  rodadas; requisições acima de 8000 tokens por minuto falharam no NodeGoat
  e no Juice Shop; o gate com 1 rodada por caso reprova por variação do
  modelo (TD-44); só Testing é calibrada, as outras bases vêm da v1
  (TD-50); falsos positivos que sobraram (TD-51).
-->

1. **O que funcionou:**
2. **O que não funcionou:**
3. **O que me surpreendeu:**
4. **O que muda na próxima fase:**
5. **O que eu ainda não sei explicar sem consultar** (próximo ponto de estudo):
