import type { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/app.ts";
import type { Clock, Sleep } from "../src/clock.ts";
import { insertConnection, openDb, saveObservations } from "../src/db.ts";
import type { SocialProvider } from "../src/provider.ts";
import { runSync, type SyncConfig, type SyncOutcome } from "../src/sync.ts";
import type { SimulatedPost } from "../src/providers/simulated.ts";

/** Relógio manual: só anda quando o teste manda ou quando o sleep fake "dorme". */
export class FakeClock implements Clock {
  constructor(private ms: number = Date.parse("2026-03-10T12:00:00.000Z")) {}
  now(): Date {
    return new Date(this.ms);
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

export function makeSleep(clock: FakeClock): { sleep: Sleep; waits: number[] } {
  const waits: number[] = [];
  const sleep: Sleep = async (ms) => {
    waits.push(ms);
    clock.advance(ms);
  };
  return { sleep, waits };
}

export function post(id: string, publishedAt: string, extra: Partial<SimulatedPost> = {}): SimulatedPost {
  return { id, publishedAt, observedAt: "2026-03-10T10:00:00.000Z", views: 100, likes: 10, comments: 2, shares: 1, ...extra };
}

export function setup(provider: SocialProvider, syncConfig?: Partial<SyncConfig>) {
  const db: DatabaseSync = openDb();
  const clock = new FakeClock();
  const { sleep, waits } = makeSleep(clock);
  const conn = insertConnection(db, { creatorId: "cr_1", platform: "instagram", accessToken: "token-ficticio" });
  const store = { saveObservations: (cid: number, posts: Parameters<typeof saveObservations>[2], at: string) => saveObservations(db, cid, posts, at) };
  const sync = (since: string, until: string): Promise<SyncOutcome> =>
    runSync(
      { provider, store, clock, sleep, config: syncConfig },
      { connectionId: conn.id, platform: conn.platform, accessToken: conn.accessToken, since, until },
    );
  const app = createApp({ db, clock, sleep, provider, syncConfig });
  const count = (table: string): number => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  return { db, clock, waits, conn, sync, app, count };
}
