# tests-p117 — P-1.17 (G1): preco autoritativo no servidor

Area **isolada**, fora de `lib/payments/tests/`: o runner da P-1.6
(`scripts/run-tests.ts`) le apenas `lib/payments/tests`, portanto estes arquivos
nao entram na allow/deny-list nem disparam a guarda de integridade. Tambem estao
fora do `include` do `tsconfig.json`. Mesmo padrao de `tests-p110/`.

## O que prova

`lessonPricing.p117.test.ts` — 52 assercoes sobre `lib/payments/LessonPricing.ts`.

| Caso | Garantia |
|---|---|
| A | preco enviado == autoritativo: checkout usa o autoritativo |
| B | preco enviado menor (1 centavo): backend usa o autoritativo |
| C | preco enviado maior (999999): backend usa o autoritativo |
| D | sem `lesson.price`: backend deriva normalmente |
| E | aula diurna usa `instructor_categories.day_price` |
| F | aula noturna usa `night_price`, e so' com `has_night_lessons` |
| G | desconto por volume incide depois da definicao do preco autoritativo |
| H | comissao, split e `student_charge` derivam do autoritativo |
| I | `lesson.price` nao resta como fonte financeira em nenhum caminho |

Inclui tipos hostis no campo nao confiavel (string, null, NaN, objeto, negativo)
e os caminhos fail-closed (preco nulo, zero, ou `night_price` ausente em aula
noturna).

## Isolamento

Nenhum Supabase, Asaas, HTTP, banco ou credencial. `LessonPricing.ts` nao tem
imports; o teste importa apenas esse modulo.

## Como executar (Windows)

```powershell
npx tsx tests-p117/lessonPricing.p117.test.ts
```

## Verificacao do `night_price = 0` (somente leitura)

A P-1.17 introduziu recusa fail-closed quando o preco autoritativo nao e' um
inteiro positivo em centavos. Isso levantou a duvida de haver instrutor em
producao cujo checkout passaria a falhar.

Consulta READ-ONLY encontrou **uma unica** linha com `night_price` nulo ou zero:

| campo | valor |
|---|---|
| `instructor_id` | `44c3f8cc-bc88-4c4d-a926-e31ff54e6651` |
| `category` | `B` |
| `day_price` | `11000` |
| `night_price` | `0` |
| `instructors.has_night_lessons` | `false` |
| `instructors.base_price` / `night_price` | `11000` / `0` |
| `instructors.categories` | `["B"]` |
| linhas do instrutor em `instructor_categories` | `1` |

**O risco NAO se materializa no estado atual**, por duas barreiras independentes
e ambas a montante do preco:

1. `api/create-booking-intent.ts:345` recusa qualquer horario `>= 18:00` quando
   `has_night_lessons` e' falso, com HTTP 400, antes de derivar preco.
2. `LessonPricing.resolveLessonPrice` so' consulta `night_price` quando
   `isNight && has_night_lessons`. Com `has_night_lessons = false` a resolucao
   cai sempre em `day_price = 11000`.

Portanto `night_price = 0` e' inalcancavel para este instrutor e **nenhuma
alteracao de dados e' necessaria**. A recusa fail-closed permanece como protecao
para um estado que hoje nao existe: `night_price` zerado ou nulo em instrutor que
efetivamente ofereca aulas noturnas.
