import { describe, expect, it } from "vitest";
import { SimulatedProvider } from "../src/providers/simulated.ts";
import { post, setup } from "./helpers.ts";

const body = (o: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(o) });
const posts = [post("a", "2026-03-02T10:00:00Z"), post("b", "2026-03-05T10:00:00Z")];

describe("API", () => {
  it("fluxo: cria conexão, sincroniza, repete e lê posts e snapshots", async () => {
    const t = setup(new SimulatedProvider(posts));
    const created = await t.app.request("/connections", body({ creator_id: "cr_9", platform: "tiktok", access_token: "t" }));
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: number };
    const win = { since: "2026-03-01T00:00:00Z", until: "2026-03-31T00:00:00Z" };
    const r1 = await t.app.request(`/connections/${id}/sync`, body(win));
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ status: "ok", posts_created: 2, posts_unchanged: 0 });
    const r2 = await t.app.request(`/connections/${id}/sync`, body(win));
    expect(await r2.json()).toMatchObject({ status: "ok", posts_created: 0, posts_unchanged: 2 });
    const list = (await (await t.app.request(`/connections/${id}/posts`)).json()) as { posts: Array<{ id: number; last_fetched_at: string }> };
    expect(list.posts).toHaveLength(2);
    expect(list.posts[0]!.last_fetched_at).toBe(t.clock.now().toISOString());
    const snaps = (await (await t.app.request(`/posts/${list.posts[0]!.id}/snapshots`)).json()) as { snapshots: Array<{ fetched_at: string }> };
    expect(snaps.snapshots).toHaveLength(1);
    expect(snaps.snapshots[0]!.fetched_at).toBeTruthy();
    const runs = (await (await t.app.request(`/connections/${id}/sync-runs`)).json()) as { runs: unknown[] };
    expect(runs.runs).toHaveLength(2);
  });

  it("429 acima do teto responde 429 com header Retry-After e registra a execução", async () => {
    const t = setup(new SimulatedProvider(posts, { faults: [{ kind: "rate_limit", retryAfter: "90" }] }));
    const res = await t.app.request(`/connections/${t.conn.id}/sync`, body({ since: "2026-03-01", until: "2026-03-31" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("90");
    expect(await res.json()).toMatchObject({ status: "rate_limited", retry_after_seconds: 90 });
    expect(t.count("sync_runs")).toBe(1);
  });

  it("falha esgotada responde 502 com o motivo", async () => {
    const t = setup(new SimulatedProvider(posts, { faults: Array(10).fill({ kind: "timeout" }) }));
    const res = await t.app.request(`/connections/${t.conn.id}/sync`, body({ since: "2026-03-01", until: "2026-03-31" }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ status: "failed" });
  });

  it("valida entrada: 400 corpo inválido, 422 janela invertida, 404 conexão inexistente", async () => {
    const t = setup(new SimulatedProvider(posts));
    expect((await t.app.request("/connections", body({ platform: "orkut" }))).status).toBe(400);
    expect((await t.app.request(`/connections/${t.conn.id}/sync`, body({ since: "x" }))).status).toBe(400);
    expect((await t.app.request(`/connections/${t.conn.id}/sync`, body({ since: "2026-03-31", until: "2026-03-01" }))).status).toBe(422);
    expect((await t.app.request("/connections/999/sync", body({ since: "2026-03-01", until: "2026-03-02" }))).status).toBe(404);
  });
});
