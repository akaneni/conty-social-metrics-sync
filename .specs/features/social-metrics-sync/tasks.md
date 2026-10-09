# Tarefas

- [x] T1 Esqueleto (package, tsconfig, vitest). Verificação: `npm run typecheck`.
- [x] T2 Fronteira: `provider.ts` (interface, tipos de domínio, erros), `clock.ts`. Verificação: typecheck.
- [x] T3 `retry-after.ts` (teste primeiro). Depende de T2.
- [x] T4 `db.ts` (esquema + `saveObservations`) com testes de idempotência (IDEM-01..04, TIME-01). Depende de T2.
- [x] T5 `providers/simulated.ts` (formato próprio, paginação, falhas roteirizadas). Depende de T2.
- [x] T6 `sync.ts` (retry, 429) com testes RETRY/RL. Depende de T3, T4, T5.
- [x] T7 `app.ts` + `index.ts` + teste de API. Depende de T6.
- [x] T8 Teste de fronteira (BOUND-01).
- [x] T9 README, mutações de verificação, subida real com curl.
