import { describe, expect, it } from "vitest";
import { SimulatedProvider } from "../src/providers/simulated.ts";
import { post, setup } from "./helpers.ts";

const W = ["2026-03-01T00:00:00Z", "2026-03-31T23:59:59Z"] as const;
const posts = [post("a", "2026-03-02T10:00:00Z")];

describe("429 do provedor", () => {
  it("Retry-After: 2 espera exatamente 2 s no relógio controlado", async () => {
    const t = setup(new SimulatedProvider(posts, { faults: [{ kind: "rate_limit", retryAfter: "2" }] }));
    const before = t.clock.now().getTime();
    const out = await t.sync(...W);
    expect(out).toMatchObject({ status: "ok", attempts: 2, postsCreated: 1 });
    expect(t.waits).toEqual([2000]);
    expect(t.clock.now().getTime() - before).toBe(2000);
  });

  it("Retry-After como data HTTP espera a diferença para o relógio", async () => {
    const t = setup(new SimulatedProvider(posts, { faults: [{ kind: "rate_limit", retryAfter: "Tue, 10 Mar 2026 12:00:07 GMT" }] }));
    const out = await t.sync(...W);
    expect(out.status).toBe("ok");
    expect(t.waits).toEqual([7000]);
  });

  it("Retry-After igual ao teto ainda espera", async () => {
    const t = setup(new SimulatedProvider(posts, { faults: [{ kind: "rate_limit", retryAfter: "30" }] }));
    const out = await t.sync(...W);
    expect(out.status).toBe("ok");
    expect(t.waits).toEqual([30_000]);
  });

  it("Retry-After acima do teto aborta como rate_limited, sem dormir, e registra retry_after_seconds", async () => {
    const provider = new SimulatedProvider(posts, { faults: [{ kind: "rate_limit", retryAfter: "31" }] });
    const t = setup(provider);
    const out = await t.sync(...W);
    expect(out).toMatchObject({ status: "rate_limited", retryAfterSeconds: 31, attempts: 1 });
    expect(t.waits).toEqual([]);
    expect(provider.calls).toBe(1);
  });

  it("o teto é configurável", async () => {
    const t = setup(new SimulatedProvider(posts, { faults: [{ kind: "rate_limit", retryAfter: "2" }] }), { maxRetryWaitMs: 1000 });
    const out = await t.sync(...W);
    expect(out).toMatchObject({ status: "rate_limited", retryAfterSeconds: 2 });
    expect(t.waits).toEqual([]);
  });

  it("429 no meio da paginação acima do teto mantém o progresso gravado", async () => {
    const two = [post("a", "2026-03-02T10:00:00Z"), post("b", "2026-03-05T10:00:00Z")];
    const t = setup(new SimulatedProvider(two, { pageSize: 1, faults: [{ kind: "ok" }, { kind: "rate_limit", retryAfter: "120" }] }));
    const out = await t.sync(...W);
    expect(out).toMatchObject({ status: "rate_limited", retryAfterSeconds: 120, postsCreated: 1 });
    expect(t.count("posts")).toBe(1);
  });

  it("429 conta para o teto de tentativas: nunca passa de 4 chamadas", async () => {
    const provider = new SimulatedProvider(posts, { faults: Array(20).fill({ kind: "rate_limit", retryAfter: "1" }) });
    const t = setup(provider);
    const out = await t.sync(...W);
    expect(out).toMatchObject({ status: "failed", attempts: 4 });
    expect(provider.calls).toBe(4);
    expect(t.waits).toEqual([1000, 1000, 1000]);
  });

  it("429 sem Retry-After é tratado como transitório (backoff)", async () => {
    const t = setup(new SimulatedProvider(posts, { faults: [{ kind: "rate_limit" }] }));
    const out = await t.sync(...W);
    expect(out.status).toBe("ok");
    expect(t.waits).toEqual([500]);
  });
});
