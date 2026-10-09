import type { Platform, SocialProvider, ProviderPost } from "./provider.ts";
import { PermanentProviderError, RateLimitedError, TransientProviderError } from "./provider.ts";
import type { Clock, Sleep } from "./clock.ts";
import { parseRetryAfterMs } from "./retry-after.ts";
import type { SaveResult } from "./db.ts";

export interface SyncConfig {
  /** Tentativas por página (a primeira conta). */
  maxAttempts: number;
  /** Espera após a 1a falha; dobra a cada nova falha. */
  backoffBaseMs: number;
  /** Maior espera aceita por um Retry-After. Acima disso, aborta sem dormir. */
  maxRetryWaitMs: number;
  /** Trava contra paginação infinita. */
  maxPages: number;
}

export const defaultSyncConfig: SyncConfig = {
  maxAttempts: 4,
  backoffBaseMs: 500,
  maxRetryWaitMs: 30_000,
  maxPages: 200,
};

/** Persistência vista pela regra de sync (sem SQL aqui). */
export interface ObservationStore {
  saveObservations(connectionId: number, posts: ProviderPost[], fetchedAt: string): SaveResult;
}

export interface SyncDeps {
  provider: SocialProvider;
  store: ObservationStore;
  clock: Clock;
  sleep: Sleep;
  config?: Partial<SyncConfig>;
}

export interface SyncTarget {
  connectionId: number;
  platform: Platform;
  accessToken: string;
  since: string;
  until: string;
}

export interface SyncOutcome {
  status: "ok" | "rate_limited" | "failed";
  attempts: number;
  pagesFetched: number;
  postsCreated: number;
  postsUpdated: number;
  postsUnchanged: number;
  retryAfterSeconds: number | null;
  error: string | null;
}

export async function runSync(deps: SyncDeps, target: SyncTarget): Promise<SyncOutcome> {
  const cfg: SyncConfig = { ...defaultSyncConfig, ...deps.config };
  const out: SyncOutcome = {
    status: "ok",
    attempts: 0,
    pagesFetched: 0,
    postsCreated: 0,
    postsUpdated: 0,
    postsUnchanged: 0,
    retryAfterSeconds: null,
    error: null,
  };
  const fail = (status: "failed" | "rate_limited", error: string): SyncOutcome => ({ ...out, status, error });

  let cursor: string | null = null;
  const seenCursors = new Set<string>();

  while (true) {
    if (out.pagesFetched >= cfg.maxPages) return fail("failed", "Limite de páginas por sincronização atingido");

    // Uma página: até maxAttempts chamadas ao provedor.
    let page;
    for (let attempt = 1; ; attempt++) {
      out.attempts++;
      try {
        page = await deps.provider.fetchPosts({
          token: target.accessToken,
          platform: target.platform,
          since: target.since,
          until: target.until,
          cursor,
        });
        break;
      } catch (err) {
        if (err instanceof PermanentProviderError) {
          return fail("failed", `Provedor recusou a requisição (${err.status}): ${err.message}`);
        }
        let waitMs: number;
        let reason: string;
        if (err instanceof RateLimitedError) {
          const retryAfterMs = parseRetryAfterMs(err.retryAfter, deps.clock.now());
          if (retryAfterMs !== null && retryAfterMs > cfg.maxRetryWaitMs) {
            out.retryAfterSeconds = Math.ceil(retryAfterMs / 1000);
            return fail("rate_limited", "Provedor pediu uma espera maior que o teto configurado; sincronização abortada");
          }
          reason = "429";
          waitMs = retryAfterMs ?? backoff(cfg, attempt);
        } else if (err instanceof TransientProviderError) {
          reason = err.kind;
          waitMs = backoff(cfg, attempt);
        } else {
          throw err;
        }
        if (attempt >= cfg.maxAttempts) {
          return fail("failed", `Tentativas esgotadas (${cfg.maxAttempts}) na página; última falha: ${reason}`);
        }
        await deps.sleep(waitMs);
      }
    }

    out.pagesFetched++;
    const saved = deps.store.saveObservations(target.connectionId, page.posts, deps.clock.now().toISOString());
    out.postsCreated += saved.created;
    out.postsUpdated += saved.updated;
    out.postsUnchanged += saved.unchanged;

    if (page.nextCursor === null) return out;
    if (seenCursors.has(page.nextCursor)) return fail("failed", "Provedor repetiu o cursor de paginação");
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

function backoff(cfg: SyncConfig, attempt: number): number {
  return cfg.backoffBaseMs * 2 ** (attempt - 1);
}
