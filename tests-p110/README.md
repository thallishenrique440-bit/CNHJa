# tests-p110 — Validacao funcional da P-1.9

Area **isolada**, fora de `lib/payments/tests/`. Nao faz parte da suite P-1.6:
o runner (`scripts/run-tests.ts`) le apenas `lib/payments/tests`, portanto estes
arquivos nao entram na allow/deny-list nem disparam a guarda de integridade.
Tambem estao fora do `include` do `tsconfig.json`, logo nao afetam `npm run lint`.

## O que provam

| Arquivo | Achados |
|---|---|
| `dispatcher.p110.test.ts` | A-1 (ledgerId real), A-8.5 (zero rows), A-8.2 (cap 10) |
| `webhook-a2.p110.test.ts` | A-2 (rethrow de LedgerPersistenceError nos 2 catches aninhados) |

## Isolamento

- Nenhum Supabase, Asaas, HTTP, banco ou credencial real.
- `webhook-a2` importa `api/asaas-webhook.ts`, que cria um client Supabase no topo
  do modulo. Por isso o SDK e substituido pelo stub em `stub/@supabase/supabase-js`.
- As env vars sao valores explicitamente invalidos (`http://p110.invalid`).
  `.env.local` NUNCA e lido.

## Como executar (Windows)

O `dispatcher` nao importa o webhook e roda direto:

```powershell
npx tsx tests-p110/dispatcher.p110.test.ts
```

O `webhook-a2` precisa do stub no caminho de resolucao. Compile para uma pasta
temporaria e copie o stub para `node_modules` dela:

```powershell
npx tsc tests-p110/webhook-a2.p110.test.ts --outDir .p110-tmp --rootDir . `
  --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck
New-Item -ItemType Directory -Force .p110-tmp\node_modules\@supabase | Out-Null
Copy-Item -Recurse -Force tests-p110\stub\@supabase\supabase-js .p110-tmp\node_modules\@supabase\
node .p110-tmp\tests-p110\webhook-a2.p110.test.js
Remove-Item -Recurse -Force .p110-tmp
```

Resultado esperado: `dispatcher` 35 PASS / 0 FAIL · `webhook-a2` 17 PASS / 0 FAIL.

## Controle negativo

Ambos foram verificados contra o codigo SEM as correcoes da P-1.9:

- removendo os 2 rethrows -> `webhook-a2` cai para 15 PASS / **2 FAIL**
- trocando `payload.ledgerId` por `payload.eventId` -> `dispatcher` acusa **9 FAIL**

Um teste que passa com e sem a correcao nao prova nada; estes discriminam.
