# Meu analisador de código deu 30 para o próprio código. Os números eram falsos.

*Renato Marques · outubro de 2026*

Eu construí o **codedriven**, um auditor de codebases JavaScript/TypeScript:
você importa um repositório, ele mede o código com regras determinísticas,
pede a um LLM uma revisão de arquitetura, segurança e performance, e devolve
uma nota de 0 a 100 por categoria.

O primeiro teste óbvio era rodar o analisador nele mesmo. Deu **30/100**.

Seria fácil concluir que o código era ruim. Mas olhando de perto, a nota
estava errada em quase tudo:

- **Testing 0**, num repositório com 169 testes. A regra comparava nomes de
  arquivo: `oauth-icons.tsx` virava "área crítica sem teste" só porque o
  nome contém `auth`.
- **Code Quality 0**, porque cada função longa tirava pontos sem teto. Uma
  regra repetida dez vezes zerava a categoria.
- **Security 16**, por um "segredo" que era um texto gerado dentro de um
  arquivo de teste.

Este artigo é sobre o que eu fiz com isso, e principalmente sobre o que eu
**não** fiz.

## A tentação: ajustar a nota até ela ficar bonita

Com o código do analisador na mão, eu poderia subir a base de Testing,
ignorar arquivos de teste na busca de segredos, colocar um piso em Code
Quality, e em uma tarde o repositório estaria com 80. O gráfico ficaria
ótimo no README.

E o analisador continuaria errado para todos os outros repositórios. Uma
nota que você calibra para o próprio código mede o quanto você gosta do
próprio código.

A regra que eu adotei: **nenhuma nota muda sem uma referência externa que
diga qual é a resposta certa.**

## 1. Antes de mexer na nota, um jeito de saber se ela piorou

O primeiro passo não foi corrigir nada. Foi montar um harness de avaliação
(evals) com casos em que eu sei a resposta:

- **Repositórios sintéticos** pequenos, com problemas plantados (SQL
  injection, autorização faltando, N+1, prompt injection) e armadilhas de
  falso positivo.
- **Dois apps propositalmente vulneráveis**, o OWASP NodeGoat e o Juice
  Shop, com as vulnerabilidades anotadas por arquivo e linha.
- **O próprio repositório**, como dogfooding.

Cada resultado vai versionado para o Git, com data e commit. Todo pull
request roda a avaliação e falha se a qualidade cair. A partir daí, cada
mudança tem um antes e um depois medidos, em vez de uma impressão.

## 2. O LLM acha o que recebe

O primeiro resultado do NodeGoat foi revelador: das 9 linhas vulneráveis
anotadas, **só 2 chegavam ao modelo**. O resto nem entrava na amostra.

O LLM não lê o repositório inteiro: ele recebe uma amostra de cerca de 16
mil caracteres. Bibliotecas de terceiros (`vendor/`, `*.min.js`) ocupavam
vagas, e a amostragem pegava só o primeiro trecho de cada arquivo, enquanto
o NodeGoat escreve cada arquivo como uma função grande.

Quando a amostragem passou a priorizar código de servidor e a se espalhar
pelas pastas, o modelo passou a achar 6 a 7 das 9. A conclusão medida da
fase: **toda vulnerabilidade que chegou ao modelo foi encontrada**. O
gargalo não era o modelo, era o que eu mandava para ele.

## 3. Falsos positivos viram casos de teste

O LLM também inventa problemas. Dois exemplos reais, do relatório deste
repositório:

- "Caractere solto causando erro de sintaxe" em código que compila. O trecho
  enviado era cortado no meio de uma expressão, e o modelo lia o corte como
  bug.
- "Checagem de sessão repetida, mova para o middleware", sobre rotas que
  verificam a sessão em cada handler de propósito (defesa em profundidade: o
  middleware sozinho pode ser contornado).

Para cada falso positivo conhecido, a avaliação ganhou um **achado
proibido**: se o modelo voltar a reportá-lo, o PR falha. Só depois de medir o
"antes" eu mexi no prompt, com regras gerais em vez de uma exceção por
arquivo ("assuma que o código compila", "um problema de segurança precisa de
um jeito concreto de ser explorado"). No caso das escolhas de design, os
achados proibidos foram de 3 para 0.

Os prompts ficam versionados, e o CI falha se um prompt mudar sem o
resultado da avaliação que mediu aquela versão.

## 4. Calibrar contra a realidade, não contra a vontade

Testing foi a categoria em que deu para fazer isso direito, porque existe
uma referência objetiva: a cobertura real dos testes.

A heurística do analisador estima, sem executar nada, quantos arquivos com
lógica os testes exercitam. Eu medi a cobertura real deste repositório com
v8: **63%** dos arquivos com funções tiveram alguma executada. Depois
comparei arquivo a arquivo com a estimativa:

- seguindo só as fachadas dos módulos, a estimativa dava 53% e errava 15
  arquivos testados;
- seguindo todos os imports, dava **66%**, mas marcava como testadas as
  quatro áreas críticas de auth e billing que nenhum teste executava.

A solução foi um híbrido: o percentual segue todos os imports; o alerta de
área crítica segue só as fachadas. As quatro áreas apontadas eram
exatamente as quatro sem teste (4 de 4 contra a cobertura medida). Escrevi
esses testes, e Testing foi de **0 para 80**. Desta vez, porque o código
melhorou.

## 5. O que ainda não está calibrado

Seria desonesto parar aqui. Hoje, só Testing tem uma referência externa.
As outras categorias partem de um valor fixo herdado da primeira versão,
menos o que a revisão encontrou:

- **Code Quality** cai 13 pontos de uma vez quando o projeto passa de 8
  arquivos grandes e funções longas. É um degrau arbitrário.
- **Security** ordena certo os repositórios (NodeGoat e Juice Shop tiram
  entre 0 e 26; um caso sadio, bem mais), mas a escala satura com quatro
  achados críticos, e o mesmo código varia até 26 pontos entre rodadas do
  modelo.
- **Architecture** e **Performance** não têm nenhum sinal medido ainda.

Isso está escrito no README e no registro de dívida técnica, com o plano:
calibrar Code Quality contra uma ferramenta de complexidade, Security contra
os repositórios vulneráveis com metas de faixa, e tirar Performance da
média até existir um sinal real. Uma nota que diz "não sei" é mais útil do
que uma que inventa.

## O que eu levo disso

1. **Dogfooding é o teste mais barato que existe.** O analisador errou
   primeiro no código que eu conhecia melhor, e foi por isso que eu vi o
   erro.
2. **Meça antes de mexer.** Toda melhoria começou com uma avaliação que
   falhava do jeito certo.
3. **Um LLM é tão bom quanto o contexto que recebe.** Antes de trocar de
   modelo ou de prompt, olhe o que ele está lendo.
4. **Falso positivo conhecido é um caso de teste.** Não basta corrigir; ele
   precisa falhar o CI se voltar.
5. **Calibre contra a realidade.** Se você não tem uma referência externa
   para uma métrica, diga isso em vez de mostrar um número com confiança.

O código, as avaliações versionadas e as decisões (ADRs) estão no
repositório: [github.com/renatomf/nextjs-codedriven](https://github.com/renatomf/nextjs-codedriven).
