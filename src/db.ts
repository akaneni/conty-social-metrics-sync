import { DatabaseSync } from "node:sqlite";
import type { Platform, ProviderPost } from "./provider.ts";

export function openDb(path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      creator_id TEXT NOT NULL,
      platform TEXT NOT NULL CHECK (platform IN ('instagram','tiktok','youtube','x')),
      access_token TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connection_id INTEGER NOT NULL REFERENCES connections(id),
      platform_post_id TEXT NOT NULL,
      published_at TEXT NOT NULL,
      views INTEGER NOT NULL,
      likes INTEGER NOT NULL,
      comments INTEGER NOT NULL,
      shares INTEGER NOT NULL,
      observed_at TEXT NOT NULL,
      last_fetched_at TEXT NOT NULL,
      UNIQUE (connection_id, platform_post_id)
    );
    CREATE TABLE IF NOT EXISTS metric_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL REFERENCES posts(id),
      observed_at TEXT NOT NULL,
      views INTEGER NOT NULL,
      likes INTEGER NOT NULL,
      comments INTEGER NOT NULL,
      shares INTEGER NOT NULL,
      fetched_at TEXT NOT NULL,
      UNIQUE (post_id, observed_at)
    );
    CREATE TABLE IF NOT EXISTS snapshot_conflicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL REFERENCES posts(id),
      observed_at TEXT NOT NULL,
      views INTEGER NOT NULL,
      likes INTEGER NOT NULL,
      comments INTEGER NOT NULL,
      shares INTEGER NOT NULL,
      payload TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      UNIQUE (post_id, observed_at, views, likes, comments, shares)
    );
    CREATE TABLE IF NOT EXISTS sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connection_id INTEGER NOT NULL REFERENCES connections(id),
      since TEXT NOT NULL,
      until TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ok','rate_limited','failed')),
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      pages_fetched INTEGER NOT NULL,
      posts_created INTEGER NOT NULL,
      posts_updated INTEGER NOT NULL,
      posts_unchanged INTEGER NOT NULL,
      snapshot_conflicts INTEGER NOT NULL DEFAULT 0,
      retry_after_seconds INTEGER,
      error TEXT
    );
  `);
  return db;
}

export interface Connection {
  id: number;
  creatorId: string;
  platform: Platform;
  accessToken: string;
}

export function insertConnection(
  db: DatabaseSync,
  input: { creatorId: string; platform: Platform; accessToken: string },
): Connection {
  const r = db
    .prepare("INSERT INTO connections (creator_id, platform, access_token) VALUES (?, ?, ?)")
    .run(input.creatorId, input.platform, input.accessToken);
  return { id: Number(r.lastInsertRowid), ...input };
}

export function findConnection(db: DatabaseSync, id: number): Connection | null {
  const row = db.prepare("SELECT * FROM connections WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return {
    id: Number(row.id),
    creatorId: String(row.creator_id),
    platform: row.platform as Platform,
    accessToken: String(row.access_token),
  };
}

export interface SaveResult {
  created: number;
  updated: number;
  unchanged: number;
  /** Mesmo post e mesmo observed_at com números diferentes (vale a primeira gravação). */
  conflicts: number;
}

/**
 * Grava as observações de uma página, de forma idempotente.
 * - posts: upsert por (connection_id, platform_post_id); só uma observação MAIS NOVA
 *   troca os números atuais.
 * - metric_snapshots: uma linha por (post_id, observed_at); repetir não duplica
 *   e preserva o fetched_at da primeira busca.
 */
export function saveObservations(
  db: DatabaseSync,
  connectionId: number,
  posts: ProviderPost[],
  fetchedAt: string,
): SaveResult {
  const result: SaveResult = { created: 0, updated: 0, unchanged: 0, conflicts: 0 };
  const find = db.prepare(
    "SELECT id, observed_at FROM posts WHERE connection_id = ? AND platform_post_id = ?",
  );
  const insertPost = db.prepare(
    `INSERT INTO posts (connection_id, platform_post_id, published_at, views, likes, comments, shares, observed_at, last_fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updatePost = db.prepare(
    `UPDATE posts SET published_at = ?, views = ?, likes = ?, comments = ?, shares = ?, observed_at = ?, last_fetched_at = ?
     WHERE id = ?`,
  );
  const touchPost = db.prepare("UPDATE posts SET last_fetched_at = ? WHERE id = ?");
  const findSnapshot = db.prepare(
    "SELECT views, likes, comments, shares FROM metric_snapshots WHERE post_id = ? AND observed_at = ?",
  );
  const insertConflict = db.prepare(
    `INSERT OR IGNORE INTO snapshot_conflicts (post_id, observed_at, views, likes, comments, shares, payload, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertSnapshot = db.prepare(
    `INSERT OR IGNORE INTO metric_snapshots (post_id, observed_at, views, likes, comments, shares, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  db.exec("BEGIN");
  try {
    for (const p of posts) {
      const row = find.get(connectionId, p.platformPostId) as
        | { id: number; observed_at: string }
        | undefined;
      let postId: number;
      if (!row) {
        const r = insertPost.run(
          connectionId, p.platformPostId, p.publishedAt, p.views, p.likes, p.comments, p.shares, p.observedAt, fetchedAt,
        );
        postId = Number(r.lastInsertRowid);
        result.created++;
      } else {
        postId = Number(row.id);
        const existing = findSnapshot.get(postId, p.observedAt) as
          | { views: number; likes: number; comments: number; shares: number }
          | undefined;
        if (existing) {
          touchPost.run(fetchedAt, postId);
          const same =
            existing.views === p.views && existing.likes === p.likes &&
            existing.comments === p.comments && existing.shares === p.shares;
          if (same) {
            result.unchanged++;
          } else {
            insertConflict.run(postId, p.observedAt, p.views, p.likes, p.comments, p.shares, JSON.stringify(p), fetchedAt);
            result.conflicts++;
          }
          continue;
        }
        if (p.observedAt > row.observed_at) {
          updatePost.run(p.publishedAt, p.views, p.likes, p.comments, p.shares, p.observedAt, fetchedAt, postId);
          result.updated++;
        } else {
          touchPost.run(fetchedAt, postId);
          result.unchanged++;
        }
      }
      insertSnapshot.run(postId, p.observedAt, p.views, p.likes, p.comments, p.shares, fetchedAt);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return result;
}

export interface SyncRunRecord {
  connectionId: number;
  since: string;
  until: string;
  status: "ok" | "rate_limited" | "failed";
  startedAt: string;
  finishedAt: string;
  attempts: number;
  pagesFetched: number;
  postsCreated: number;
  postsUpdated: number;
  postsUnchanged: number;
  snapshotConflicts: number;
  retryAfterSeconds: number | null;
  error: string | null;
}

export function insertSyncRun(db: DatabaseSync, r: SyncRunRecord): number {
  const res = db
    .prepare(
      `INSERT INTO sync_runs (connection_id, since, until, status, started_at, finished_at, attempts, pages_fetched,
         posts_created, posts_updated, posts_unchanged, snapshot_conflicts, retry_after_seconds, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      r.connectionId, r.since, r.until, r.status, r.startedAt, r.finishedAt, r.attempts, r.pagesFetched,
      r.postsCreated, r.postsUpdated, r.postsUnchanged, r.snapshotConflicts, r.retryAfterSeconds, r.error,
    );
  return Number(res.lastInsertRowid);
}
