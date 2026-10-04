# ADR-009 — Estratégia de evals e gate no CI

- **Status:** aceita — registro retroativo (2026-10-04): a decisão foi
  implementada na Fase 7 e revista depois dela (#132–#136); esta ADR
  registra o que já vale
- **Data:** 2026-10-04
- **Fase do roadmap:** 7 — Evals e qualidade da análise

## Contexto

- O produto é a **análise**: heurísticas, a fórmula da nota, a amostra de
  código enviada ao LLM, o prompt da revisão e a busca do chat.
- Em 2026-09-29, o analisador deu **30/100** a este repositório, quase só
  com falsos positivos ([baseline](../baseline.md)). Ninguém tinha
  percebido: não havia número para comparar antes e depois de uma mudança.
- O LLM é caro, lento e não determinístico. O Groq gratuito dá 200 mil
  tokens por dia por organização, e uma rodada completa do eval gasta cerca
  de 60 mil.
- O CI não tem chave do LLM em todos os jobs, e um job obrigatório não pode
  depender de uma cota diária externa.

## Problema

Como impedir que uma mudança na análise a piore sem ninguém notar, sem
gastar a cota do LLM em todo pull request?

## Opções consideradas

1. **Revisão manual de relatórios.** Não escala e não tem número.
2. **Um eval só, com o LLM, em todo PR.** Mede tudo, mas gasta a cota
   diária em poucos PRs e torna o merge refém do provedor.
3. **Dois níveis:** um eval determinístico, obrigatório em todo PR, e um
   eval com o modelo real, só quando o que ele mede muda.

## Decisão

Opção 3.

**Eval determinístico** (`npm run eval`, job obrigatório *Analysis eval*):
roda sem LLM, sem rede além dos repositórios fixados, sem custo e sem
segredo. Mede:

- casos anotados (projetos sintéticos com cada achado esperado listado):
  precisão e recall;
- repositórios reais com vulnerabilidades anotadas por linha (OWASP
  NodeGoat e Juice Shop, num commit fixo): quantas linhas vulneráveis chegam
  à amostra do LLM;
- este repositório (dogfooding): achados por regra e as notas
  determinísticas;
- a busca do chat (perguntas escritas antes da primeira medição):
  recall@k, hit@1 e MRR.

Cada métrica tem um **portão** (`GATE`). Um limite só sobe quando uma
melhoria entra, e nunca desce para uma mudança passar.

**LLM eval** (workflow *LLM eval*, não obrigatório): o modelo real, uma
rodada por caso, e só quando mudam a análise, o prompt, a configuração do
modelo ou o próprio eval. Usa uma **chave de outra conta Groq**
(`GROQ_EVAL_API_KEY`) e nunca lê a chave de produção. Falha se:

- um caso não tem nenhuma rodada bem-sucedida;
- um achado cita um arquivo que o modelo não recebeu;
- o recall cai abaixo do baseline;
- aparece um **achado proibido**: um falso positivo conhecido, de um
  arquivo (desde #134) ou do projeto inteiro (#136).

O arquivo de resultado fica guardado como artefato do workflow.

**Prompts versionados:** a versão de um prompt é o hash do texto fixo.
`evals/prompts.lock.json` registra cada versão com o resultado que a
mediu, e um teste do CI falha quando o prompt muda sem o lock. Quem muda o
prompt roda o eval e commita o resultado.

**Resultados versionados:** os resultados que marcam um marco (baseline,
antes e depois de cada melhoria) são commitados em `evals/results/`, e
deles sai o gráfico de dogfooding.

## Trade-offs e consequências

- **Melhor:** toda mudança na análise mostra o efeito em número. Os falsos
  positivos que motivaram esta ADR viraram casos que não podem voltar.
- **Pior:** o LLM eval leva cerca de 9 minutos (pausas para o limite por
  minuto do Groq gratuito). Ele pode falhar por cota esgotada, o que não é
  uma regressão (aconteceu em 2026-10-04, #136). Uma rodada por caso não
  mede estabilidade: o eval local roda 3.
- **Limite conhecido:** o eval mede **recall** contra problemas anotados e
  **precisão** só nos falsos positivos conhecidos. Ainda não diz se a nota
  **ordena** bem projetos bons e ruins (TD-50).
- **Obrigatório:** toda mudança no prompt atualiza o lock com um resultado
  medido. Todo falso positivo corrigido vira um achado proibido.
- **Revisão:** sair do plano gratuito do Groq (o LLM eval poderia ser
  obrigatório) ou criar o corpus de referência do TD-50.
