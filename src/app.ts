import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import type { Clock, Sleep } from "./clock.ts";
import { PLATFORMS, type Platform, type SocialProvider } from "./provider.ts";
import { findConnection, insertConnection, insertSyncRun, saveObservations } from "./db.ts";
import { runSync, type SyncConfig } from "./sync.ts";

export interface AppDeps {
  db: DatabaseSync;
  clock: Clock;
  sleep: Sleep;
  provider: SocialProvider;
  syncConfig?: Partial<SyncConfig>;
}

function parseDate(v: unknown): string | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function parseId(v: string): number | null {
  return /^\d+$/.test(v) ? Number(v) : null;
}

export function createApp(deps: AppDeps): Hono {
  const { db, clock } = deps;
  const app = new Hono();

  app.post("/connections", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (
      !body || typeof body.creator_id !== "string" || body.creator_id === "" ||
      !PLATFORMS.includes(body.platform) || typeof body.access_token !== "string" || body.access_token === ""
    ) {
      return c.json({ error: "Corpo inválido: informe creator_id, platform (instagram|tiktok|youtube|x) e access_token" }, 400);
    }
    const conn = insertConnection(db, {
      creatorId: body.creator_id,
      platform: body.platform as Platform,
      accessToken: body.access_token,
    });
    return c.json({ id: conn.id, creator_id: conn.creatorId, platform: conn.platform }, 201);
  });

  app.post("/connections/:id/sync", async (c) => {
    const id = parseId(c.req.param("id"));
    const conn = id === null ? null : findConnection(db, id);
    if (!conn) return c.json({ error: "Conexão não encontrada" }, 404);
    const body = await c.req.json().catch(() => null);
    const since = parseDate(body?.since);
    const until = parseDate(body?.until);
    if (!since || !until) return c.json({ error: "Corpo inválido: since e until devem ser datas ISO" }, 400);
    if (since > until) return c.json({ error: "since não pode ser depois de until" }, 422);

    const startedAt = clock.now().toISOString();
    const outcome = await runSync(
      {
        provider: deps.provider,
        store: { saveObservations: (cid, posts, at) => saveObservations(db, cid, posts, at) },
        clock,
        sleep: deps.sleep,
        config: deps.syncConfig,
      },
      { connectionId: conn.id, platform: conn.platform, accessToken: conn.accessToken, since, until },
    );
    const finishedAt = clock.now().toISOString();
    const runId = insertSyncRun(db, {
      connectionId: conn.id, since, until, startedAt, finishedAt, ...outcome,
    });
    const summary = {
      run_id: runId,
      status: outcome.status,
      attempts: outcome.attempts,
      pages_fetched: outcome.pagesFetched,
      posts_created: outcome.postsCreated,
      posts_updated: outcome.postsUpdated,
      posts_unchanged: outcome.postsUnchanged,
      snapshot_conflicts: outcome.snapshotConflicts,
      retry_after_seconds: outcome.retryAfterSeconds,
      error: outcome.error,
      started_at: startedAt,
      finished_at: finishedAt,
    };
    if (outcome.status === "rate_limited") {
      return c.json(summary, 429, { "Retry-After": String(outcome.retryAfterSeconds) });
    }
    return c.json(summary, outcome.status === "ok" ? 200 : 502);
  });

  app.get("/connections/:id/posts", (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null || !findConnection(db, id)) return c.json({ error: "Conexão não encontrada" }, 404);
    const rows = db
      .prepare(
        `SELECT id, platform_post_id, published_at, views, likes, comments, shares, observed_at, last_fetched_at
         FROM posts WHERE connection_id = ? ORDER BY published_at, id`,
      )
      .all(id);
    return c.json({ posts: rows });
  });

  app.get("/posts/:id/snapshots", (c) => {
    const id = parseId(c.req.param("id"));
    const post = id === null ? undefined : db.prepare("SELECT id FROM posts WHERE id = ?").get(id);
    if (!post) return c.json({ error: "Post não encontrado" }, 404);
    const rows = db
      .prepare(
        `SELECT observed_at, views, likes, comments, shares, fetched_at
         FROM metric_snapshots WHERE post_id = ? ORDER BY observed_at`,
      )
      .all(id);
    return c.json({ snapshots: rows });
  });

  app.get("/connections/:id/sync-runs", (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null || !findConnection(db, id)) return c.json({ error: "Conexão não encontrada" }, 404);
    return c.json({ runs: db.prepare("SELECT * FROM sync_runs WHERE connection_id = ? ORDER BY id").all(id) });
  });

  return app;
}
