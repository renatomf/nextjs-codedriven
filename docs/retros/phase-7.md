# Retro — Fase 7 (evals + qualidade da análise)

- **Período:** 2026-09-30 (harness, PR #55) a 2026-09-30 (PR #76); ajustes
  de 2026-10-04 (PR #132) a 2026-10-05 (PR #136)
- **Estimado × real:** sem estimativa prévia; real de 1 dia (PRs #55 a #76) e mais 2 dias de
  ajustes (#132 a #136)
- **Números:** README (tabela "Antes × Depois"), ADR-010 e `evals/results/`

1. **O que funcionou:** primeiro o harness, depois as melhorias, sempre
   contra um baseline versionado. Cada mudança de prompt passou a ter antes
   × depois (o lock dos prompts no CI obriga): erros de sintaxe em código
   válido (TD-48) e escolhas de design como defeito (TD-49, 3 achados
   proibidos → 0). E calibrar Testing contra a cobertura medida com v8
   (estimativa 66%, real 63%) deu à única nota calibrada uma base real.
2. **O que não funcionou:** a cota do Groq. Os 200 mil tokens diários
   acabaram no meio de rodadas, requisições acima de 8000 tokens por minuto
   falharam no NodeGoat e no Juice Shop, e o gate com uma rodada por caso
   reprova por variação do modelo (TD-44). Um gate que falha ao acaso deixa
   de proteger o prompt.
3. **O que me surpreendeu:** o modelo acha o que recebe (toda
   vulnerabilidade enviada foi achada; o chat cita com validade 1,00 e se
   abstém quando não há resposta). O limite é o que chega a ele: no começo,
   só 2 de 9 linhas vulneráveis do NodeGoat entravam na amostra. E o
   analisador deu 0 em Testing para este repositório, com 169 testes.
4. **O que muda na próxima fase (v2.1):** calibrar as outras categorias
   contra referências (TD-50), na ordem Code Quality, TD-44 com o orçamento
   de tokens, e Security; nunca para este repositório tirar nota melhor.
5. **O que eu ainda não sei explicar sem consultar** (candidatos, a
   confirmar): como a amostragem por risco escolhe os chunks e por que ela
   perde vulnerabilidades em arquivos grandes; e o que o `reviewInputHash`
   inclui para a nota não oscilar entre reanálises.
