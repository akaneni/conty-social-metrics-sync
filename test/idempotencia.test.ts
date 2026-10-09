import { describe, expect, it } from "vitest";
import { SimulatedProvider } from "../src/providers/simulated.ts";
import { post, setup } from "./helpers.ts";

const W = ["2026-03-01T00:00:00Z", "2026-03-31T23:59:59Z"] as const;

const posts = [
  post("a", "2026-03-02T10:00:00Z"),
  post("b", "2026-03-05T10:00:00Z"),
  post("c", "2026-03-20T10:00:00Z"),
];

describe("idempotência da sincronização", () => {
  it("o mesmo payload duas vezes não duplica post nem snapshot", async () => {
    const t = setup(new SimulatedProvider(posts));
    const first = await t.sync(...W);
    const second = await t.sync(...W);
    expect(first).toMatchObject({ status: "ok", postsCreated: 3, postsUnchanged: 0 });
    expect(second).toMatchObject({ status: "ok", postsCreated: 0, postsUpdated: 0, postsUnchanged: 3 });
    expect(t.count("posts")).toBe(3);
    expect(t.count("metric_snapshots")).toBe(3);
    const row = t.db.prepare("SELECT views, likes, comments, shares FROM posts WHERE platform_post_id = 'a'").get();
    expect({ ...row }).toEqual({ views: 100, likes: 10, comments: 2, shares: 1 });
  });

  it("janelas sobrepostas contam o post da interseção uma vez, com números iguais", async () => {
    const t = setup(new SimulatedProvider(posts));
    await t.sync("2026-03-01T00:00:00Z", "2026-03-10T00:00:00Z"); // a, b
    const second = await t.sync("2026-03-04T00:00:00Z", "2026-03-31T00:00:00Z"); // b, c
    expect(second).toMatchObject({ postsCreated: 1, postsUnchanged: 1 });
    expect(t.count("posts")).toBe(3);
    expect(t.count("metric_snapshots")).toBe(3);
    const b = t.db.prepare("SELECT views, likes FROM posts WHERE platform_post_id = 'b'").get();
    expect({ ...b }).toEqual({ views: 100, likes: 10 });
  });

  it("resposta duplicada dentro da mesma sincronização não duplica", async () => {
    const provider = new SimulatedProvider(posts, { pageSize: 1, duplicatePosts: true });
    const t = setup(provider);
    const out = await t.sync(...W);
    expect(out).toMatchObject({ status: "ok", postsCreated: 3 });
    expect(out.postsUnchanged).toBeGreaterThan(0);
    expect(t.count("posts")).toBe(3);
    expect(t.count("metric_snapshots")).toBe(3);
  });

  it("observação mais nova atualiza os números e acumula histórico, sem somar", async () => {
    const provider = new SimulatedProvider(posts);
    const t = setup(provider);
    await t.sync(...W);
    provider.setPosts([post("a", "2026-03-02T10:00:00Z", { observedAt: "2026-03-10T11:00:00.000Z", views: 150 }), posts[1]!, posts[2]!]);
    const out = await t.sync(...W);
    expect(out).toMatchObject({ postsUpdated: 1, postsUnchanged: 2 });
    const a = t.db.prepare("SELECT views FROM posts WHERE platform_post_id = 'a'").get() as { views: number };
    expect(a.views).toBe(150);
    expect(t.count("metric_snapshots")).toBe(4);
  });

  it("observação mais antiga entra no histórico mas não sobrescreve os números atuais", async () => {
    const provider = new SimulatedProvider(posts);
    const t = setup(provider);
    await t.sync(...W);
    provider.setPosts([post("a", "2026-03-02T10:00:00Z", { observedAt: "2026-03-09T08:00:00.000Z", views: 40 }), posts[1]!, posts[2]!]);
    const out = await t.sync(...W);
    expect(out.postsUpdated).toBe(0);
    const a = t.db.prepare("SELECT views, observed_at FROM posts WHERE platform_post_id = 'a'").get() as { views: number; observed_at: string };
    expect(a).toMatchObject({ views: 100, observed_at: "2026-03-10T10:00:00.000Z" });
    expect(t.count("metric_snapshots")).toBe(4);
  });

  it("grava fetched_at no snapshot e last_fetched_at no post, e preserva o fetched_at da primeira busca", async () => {
    const t = setup(new SimulatedProvider(posts));
    await t.sync(...W);
    const firstFetch = t.clock.now().toISOString();
    t.clock.advance(3_600_000);
    await t.sync(...W);
    const snap = t.db.prepare("SELECT fetched_at FROM metric_snapshots LIMIT 1").get() as { fetched_at: string };
    const p = t.db.prepare("SELECT last_fetched_at FROM posts WHERE platform_post_id = 'a'").get() as { last_fetched_at: string };
    expect(snap.fetched_at).toBe(firstFetch);
    expect(p.last_fetched_at).toBe(t.clock.now().toISOString());
  });
});

describe("conflito de snapshot", () => {
  it("mesmo observed_at com números diferentes: vale a primeira gravação, conta conflito e guarda o payload divergente", async () => {
    const provider = new SimulatedProvider(posts);
    const t = setup(provider);
    await t.sync(...W);
    provider.setPosts([post("a", "2026-03-02T10:00:00Z", { views: 999 }), posts[1]!, posts[2]!]);
    const out = await t.sync(...W);
    expect(out).toMatchObject({ status: "ok", snapshotConflicts: 1, postsUnchanged: 2, postsUpdated: 0 });
    const a = t.db.prepare("SELECT views FROM posts WHERE platform_post_id = 'a'").get() as { views: number };
    expect(a.views).toBe(100);
    expect(t.count("metric_snapshots")).toBe(3);
    const c = t.db.prepare("SELECT observed_at, views, payload, fetched_at FROM snapshot_conflicts").all() as Array<{ views: number; payload: string; observed_at: string }>;
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ views: 999, observed_at: "2026-03-10T10:00:00.000Z" });
    expect(JSON.parse(c[0]!.payload)).toMatchObject({ platformPostId: "a", views: 999 });
    // repetir a mesma divergência conta de novo no resumo, mas não duplica a auditoria
    const again = await t.sync(...W);
    expect(again.snapshotConflicts).toBe(1);
    expect(t.count("snapshot_conflicts")).toBe(1);
  });
});
