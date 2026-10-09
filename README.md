# conty-social-metrics-sync

Serviço que recebe uma conexão já autorizada de um criador (Instagram, TikTok, YouTube ou X; o token pode ser fictício) e sincroniza as métricas dos posts a partir de um provedor **simulado**. Sobrevive a timeout, resposta duplicada e 429, e não conta o mesmo post duas vezes quando duas janelas se sobrepõem. Não há OAuth real.

TypeScript, Hono, `node:sqlite`, vitest. Node 22+.

## Como rodar

```bash
npm install
npm test
npm run typecheck
npm run dev        # http://localhost:3004 (banco em memória por padrão; DB_PATH para arquivo)
```

No `npm run dev` o provedor simulado serve 7 posts de demonstração, 3 por página, e só aceita o token `token-demo`.

```bash
curl -s -X POST localhost:3004/connections -H 'content-type: application/json' \
  -d '{"creator_id":"cr_1","platform":"instagram","access_token":"token-demo"}'
# {"id":1,"creator_id":"cr_1","platform":"instagram"}

curl -s -X POST localhost:3004/connections/1/sync -H 'content-type: application/json' \
  -d '{"since":"2020-01-01","until":"2030-01-01"}'
# {"run_id":1,"status":"ok","attempts":3,"pages_fetched":3,"posts_created":7,"posts_updated":0,"posts_unchanged":0,"retry_after_seconds":null,"error":null,...}

curl -s localhost:3004/connections/1/posts          # métrica atual + last_fetched_at
curl -s localhost:3004/posts/1/snapshots            # histórico, com observed_at e fetched_at
curl -s localhost:3004/connections/1/sync-runs      # execuções
```

Repetir a mesma sync devolve `posts_created: 0` e `posts_unchanged: 7` (no demo a leitura é fixada na subida; um provedor real traria `observed_at` novo e o resumo contaria `posts_updated`, com um snapshot novo no histórico).

Resposta da sync: `200` `ok`; `429` `rate_limited` (com header `Retry-After`); `502` `failed` (com `error`). O corpo é sempre o resumo. `400` corpo inválido, `404` conexão inexistente, `422` `since` depois de `until`.

## Fronteira com o provedor

`src/provider.ts` é o único contrato que a regra de negócio conhece: a interface `SocialProvider.fetchPosts({ token, platform, since, until, cursor })`, o tipo normalizado `ProviderPost` e três erros (`TransientProviderError`, `RateLimitedError`, `PermanentProviderError`). O provedor simulado (`src/providers/simulated.ts`) tem um formato de resposta próprio (`stats.view_count`, `read_at` em epoch...) que ele mesmo traduz; faltas roteirizadas (timeout, 5xx, truncada, 429, 401) e resposta duplicada vivem lá. `test/fronteira.test.ts` falha se `sync.ts`, `db.ts` ou `app.ts` importarem o simulado, ou se `sync.ts` importar Hono/SQLite ou usar `new Date()` solto. Só `src/index.ts` liga os dois.

Relógio e `sleep` são injetados (`Clock`, `Sleep`); os testes usam um relógio manual cujo `sleep` registra a espera e avança o tempo.

## Idempotência

- `posts` tem `UNIQUE(connection_id, platform_post_id)` e guarda a métrica **atual**. É upsert, nunca soma.
- `metric_snapshots` tem `UNIQUE(post_id, observed_at)` e guarda o histórico. Cada snapshot grava `fetched_at` (quando buscamos); o post grava `last_fetched_at`. Repetir uma observação mantém o `fetched_at` da primeira busca.
- `observed_at` é o instante em que o provedor leu a métrica. Observação **mais nova** que a gravada troca os números atuais; **igual ou mais antiga** só entra no histórico (se ainda não existir) e não mexe nos números.
- Por isso: payload repetido, página duplicada, retry e janelas sobrepostas caem na mesma linha de `posts` e no mesmo snapshot. O resumo conta `posts_created`, `posts_updated` (observação mais nova) e `posts_unchanged` (já conhecido).
- Cada página é gravada numa transação. Se a sync falha no meio, o que já foi gravado fica (é idempotente) e rodar de novo completa o resto.
- Limitação: se o provedor mandar `observed_at` igual com números diferentes, vale a primeira gravação.

## Falhas e 429

- Transitório (timeout, 5xx, resposta truncada): backoff exponencial de 500 ms, 1 s, 2 s, sem jitter (determinístico para teste). Máximo de **4 tentativas por página** (`maxAttempts`); esgotou, a sync termina `failed` com o motivo. Sem loop.
- 4xx (401/403/404): não retenta, `failed`.
- **429 com `Retry-After`** (segundos ou data HTTP) até o teto `maxRetryWaitMs` (padrão 30 s): dorme **exatamente** o prazo e tenta de novo; a tentativa conta para o teto de 4.
- **429 com `Retry-After` acima do teto**: aborta **sem dormir**, status `rate_limited`, `retry_after_seconds` gravado em `sync_runs` e devolvido (e header `Retry-After` na resposta HTTP). Quem chama decide quando tentar de novo.
- 429 sem `Retry-After` (ou ilegível): tratado como transitório, com backoff.
- 429 válido na última tentativa: `failed` (não sobrou tentativa para esperar).
- Paginação travada: cursor repetido ou mais de 200 páginas viram `failed`.

## Do síncrono para job em fila

`POST /connections/:id/sync` roda tudo dentro da requisição: simples e com resultado imediato, mas a requisição pode durar até alguns segundos de espera (um 429 de 30 s bloqueia o cliente) e uma janela grande pode estourar o timeout do chamador. Para evoluir:

1. `POST .../sync` só cria um `sync_runs` com status `queued` e devolve `202` com o id.
2. Um worker consome a fila, roda o mesmo `runSync` (que já recebe provedor, relógio e `sleep` por injeção) e atualiza o estado `running -> ok|rate_limited|failed`.
3. O cliente consulta `GET .../sync-runs/:id` (polling).
4. Em `rate_limited` ou 429 longo, o worker reagenda o job para `agora + retry_after` em vez de bloquear, sem ocupar a requisição. O retry sai da requisição e vira política do worker, com a mesma idempotência.
5. Um lock por conexão evita duas syncs simultâneas na mesma conexão (hoje a idempotência garante correção, mas não evita trabalho repetido).

## O que ficou de fora

OAuth real e renovação de token; provedor real; fila/worker; lock por conexão; autenticação da API; jitter no backoff; paginação nas listagens; agendamento periódico de syncs; criptografia do token no banco.

## Decisões além do enunciado

- `sync_runs` ganhou `pages_fetched` e `posts_unchanged`; `posts` ganhou `observed_at`.
- Status HTTP 429/502 para `rate_limited`/`failed` (o resumo vem no corpo nos dois casos).

## Uso de IA
- **Feito com IA:** especificação, código e testes escritos com Claude Code (Claude Sonnet 5.5), a partir de decisões do autor tomadas em entrevista (grill) e registradas em `.specs/`.
- **Revisado pelo autor:** TODO(preencher após a revisão humana do diff).
- **Revisão independente:** TODO(preencher após a revisão por agente de contexto limpo).
