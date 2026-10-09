# Sincronização de métricas das redes (social-metrics-sync)

Origem: enunciado do desafio 04 e decisões do grill (spec 04). Escopo Medium.

## Requisitos

| ID | Requisito | Critério de aceite |
|----|-----------|--------------------|
| SYNC-01 | `POST /connections/:id/sync { since, until }` busca os posts da janela no provedor, página a página, de forma síncrona, e devolve resumo (`status`, contagens, `attempts`). | Teste de API: resposta 200 com contagens. |
| IDEM-01 | `posts` é único por `(connection_id, platform_post_id)`; a métrica atual é upsert, nunca soma. | Mesmo payload duas vezes: 1 linha, números iguais. |
| IDEM-02 | Janelas sobrepostas: post na interseção é uma linha só, com números iguais. | Duas syncs sobrepostas. |
| IDEM-03 | Resposta duplicada (post repetido na mesma página ou em páginas diferentes) não duplica. | Teste com `duplicatePosts`. |
| IDEM-04 | `metric_snapshots` único por `(post_id, observed_at)`; observação mais antiga entra no histórico mas não sobrescreve os números atuais. | Teste de observação atrasada. |
| IDEM-05 | Mesmo post e `observed_at` com números diferentes: vale a primeira gravação, o resumo conta `snapshot_conflicts` e o payload divergente é guardado em `snapshot_conflicts`. | Teste de caracterização: views continua 100, `snapshotConflicts: 1`. |
| TIME-01 | `fetched_at` em cada snapshot e `last_fetched_at` no post. | Teste lê os dois valores do relógio fake. |
| RETRY-01 | Falha transitória (timeout, 5xx, resposta truncada): backoff 500 ms, 1 s, 2 s, máx. 4 tentativas por página (configurável), sem jitter. | Recupera após falhas; esgotou -> `failed`, sem loop. |
| RETRY-02 | 4xx (401/403/404) não é retentado: `failed` com motivo. | Teste 401. |
| RL-01 | 429 com `Retry-After` (segundos ou data HTTP) <= `maxRetryWaitMs` (30 s): dorme exatamente o prazo e tenta de novo, contando como tentativa. | `sleep` fake registra `[2000]`. |
| RL-02 | 429 com `Retry-After` > teto: aborta sem dormir, `rate_limited`, `retry_after_seconds` gravado; progresso já gravado fica. | `sleep` nunca chamado. |
| RL-03 | 429 sem `Retry-After` (ou inválido) é transitório (backoff). | Teste. |
| PAG-01 | Cursor repetido ou mais de `maxPages` páginas: `failed` ("Provedor repetiu o cursor" / "Limite de páginas"). | `test/paginacao.test.ts`. |
| BOUND-01 | Regra de negócio nunca importa o formato do provedor simulado; só a interface `SocialProvider`. | Teste de fronteira varre os imports. |
| DOC-01 | README: idempotência, 429, nota síncrono -> job em fila, o que ficou de fora, nota de IA. | Revisão. |

## Desvios / adições à spec do grill
- `sync_runs` ganhou `pages_fetched`, `posts_unchanged` e `snapshot_conflicts`; tabela nova `snapshot_conflicts`.
- `engines.node` é `>=22.13` (`node:sqlite` sem flag); verificado só no Node 24.
- `posts` ganhou `observed_at` (observação que originou os números atuais), necessária para a regra de observação atrasada.
- HTTP da sync: 200 `ok`, 429 `rate_limited` (com header `Retry-After`), 502 `failed`; corpo é sempre o resumo.
- 429 com `Retry-After` válido na última tentativa: `failed` (não há mais tentativa), não `rate_limited`.
