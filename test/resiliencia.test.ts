import { describe, expect, it } from "vitest";
import { SimulatedProvider } from "../src/providers/simulated.ts";
import { post, setup } from "./helpers.ts";

const W = ["2026-03-01T00:00:00Z", "2026-03-31T23:59:59Z"] as const;
const posts = [post("a", "2026-03-02T10:00:00Z"), post("b", "2026-03-05T10:00:00Z")];

describe("falhas transitórias", () => {
  it("timeout transitório recupera com backoff 500 ms e 1 s", async () => {
    const provider = new SimulatedProvider(posts, { faults: [{ kind: "timeout" }, { kind: "server_error" }] });
    const t = setup(provider);
    const out = await t.sync(...W);
    expect(out).toMatchObject({ status: "ok", attempts: 3, postsCreated: 2 });
    expect(t.waits).toEqual([500, 1000]);
  });

  it("resposta truncada é retentada", async () => {
    const t = setup(new SimulatedProvider(posts, { faults: [{ kind: "truncated" }] }));
    const out = await t.sync(...W);
    expect(out).toMatchObject({ status: "ok", attempts: 2 });
  });

  it("esgotou as tentativas: failed, sem loop, backoff 500/1000/2000", async () => {
    const provider = new SimulatedProvider(posts, { faults: Array(50).fill({ kind: "timeout" }) });
    const t = setup(provider);
    const out = await t.sync(...W);
    expect(out.status).toBe("failed");
    expect(out.attempts).toBe(4);
    expect(provider.calls).toBe(4);
    expect(t.waits).toEqual([500, 1000, 2000]);
    expect(out.error).toContain("Tentativas esgotadas");
    expect(t.count("posts")).toBe(0);
  });

  it("o teto de tentativas é configurável", async () => {
    const provider = new SimulatedProvider(posts, { faults: Array(50).fill({ kind: "timeout" }) });
    const t = setup(provider, { maxAttempts: 2 });
    const out = await t.sync(...W);
    expect(out).toMatchObject({ status: "failed", attempts: 2 });
    expect(t.waits).toEqual([500]);
  });

  it("falha no meio da paginação mantém o progresso já gravado e a repetição completa o resto", async () => {
    const provider = new SimulatedProvider(posts, { pageSize: 1, faults: [{ kind: "ok" }, ...Array(4).fill({ kind: "timeout" })] });
    const t = setup(provider);
    const first = await t.sync(...W);
    expect(first).toMatchObject({ status: "failed", pagesFetched: 1, postsCreated: 1 });
    const second = await t.sync(...W);
    expect(second).toMatchObject({ status: "ok", postsCreated: 1, postsUnchanged: 1 });
    expect(t.count("posts")).toBe(2);
  });

  it("4xx não é retentado", async () => {
    const provider = new SimulatedProvider(posts, { validToken: "outro" });
    const t = setup(provider);
    const out = await t.sync(...W);
    expect(out).toMatchObject({ status: "failed", attempts: 1 });
    expect(out.error).toContain("401");
    expect(t.waits).toEqual([]);
  });
});
