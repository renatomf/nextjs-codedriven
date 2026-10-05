# ADR-002 — Convenção dos módulos e regras de arquitetura no CI

- **Status:** aceita
- **Data:** 2026-09-30
- **Fase do roadmap:** 3 — Monólito modular + Clean Architecture (fechamento)

## Contexto

A [ADR-001](001-modular-monolith.md) decidiu um monólito modular com Clean
Architecture e DDD seletivos, e deixou a organização interna dos módulos
como **provisória** ([modules.md](../modules.md)) até haver mais de um
módulo com regra de negócio de verdade. A Fase 3 migrou seis: billing
(piloto), projects, ingestion, analysis, chat e identity. Com isso dá para
ver o que se repetiu e o que foi exceção
([results/phase-3.md](../results/phase-3.md)).

## Problema

Qual é a forma de um módulo, e quais regras valem para todos, para que o
próximo (ou a próxima pessoa) não precise redescobrir as escolhas?

## Opções consideradas

1. **Camadas completas em todo módulo** (domain, application,
   infrastructure, portas para tudo). Uniforme, mas cria interfaces e
   arquivos vazios onde não há regra (identity) e portas com uma só
   implementação. É o que a ADR-001 chamou de "arquitetura de cerimônia".
2. **Forma mínima obrigatória e camadas por necessidade.** Todo módulo tem
   a mesma fronteira pública; o interior cresce só com o que tem motivo.
3. **Sem convenção:** cada módulo à sua maneira. Rápido no começo, mas a
   fronteira pública (o que outros módulos podem importar) deixa de ser
   verificável.

## Decisão

Opção 2. Regras para **todo** módulo:

1. **Duas entradas públicas.** `index.ts` é puro (tipos e regras, sem banco,
   sem `server-only`, importável até por componentes de cliente);
   `server.ts` tem `import "server-only"` e tudo que usa banco, rede ou
   modelo. Fora do módulo, só essas duas.
2. **Camadas por necessidade.** `domain/` só quando há regra de negócio
   (identity não tem); `application/` só quando um caso de uso orquestra
   portas (billing, ingestion); `infrastructure/` para banco e integrações.
3. **Porta só com uma segunda implementação ou um fake de teste.**
   `Embedder`, `VectorStore` e `BillingRepository` existem; `PaymentGateway`,
   `LlmProvider` e `SourceProvider`, não (ainda).
4. **Regra pura + SQL condicional com a mesma regra** quando a atomicidade
   importa (claim da análise, cota): o domínio decide, o `UPDATE ... WHERE`
   garante, e testes cobrem os dois (inclusive uma corrida forçada).
5. **Toda consulta de dados do usuário recebe o `userId` da sessão**, e as
   funções públicas nunca recebem só o id do recurso (checagens auxiliares
   rodam dentro da consulta que já filtrou pelo dono).
6. **Migração por strangler, com prova:** rede de testes primeiro (em
   Postgres real quando há banco), refatoração com os testes inalterados,
   mutação para provar que o teste pega o erro; fachadas temporárias só
   enquanto há chamadores antigos.
7. **Sem React nos módulos** (o cache de request fica na entrega) e **sem
   APIs do Node no domínio** que o cliente importa.

Todas as regras de dependência estão no `dependency-cruiser` do CI; a
baseline de violações é 0 e só pode continuar 0.

## Trade-offs e consequências

- Módulos diferentes entre si por dentro (identity só tem infraestrutura;
  billing tem as três camadas). O custo é explicar isso a quem chega; o
  ganho é não manter código sem função.
- A atomicidade por SQL condicional duplica a regra (TS e SQL); aceito
  porque os dois lados são testados, e a alternativa (lock ou save otimista)
  mudaria o comportamento do claim sem ganho.
- `src/lib` continua existindo para integrações (NextAuth, GitHub, arquivos,
  rate limit) e para o que ainda não migrou (geração do relatório, na Fase
  7). Não é um módulo e não segue esta convenção.
- Revisar se: aparecer um segundo app/serviço (a fronteira vira pacote),
  ou a Fase 5 trouxer um worker que precise dos casos de uso fora do Next.
