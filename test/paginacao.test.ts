import { describe, expect, it } from "vitest";
import type { ProviderPage, SocialProvider } from "../src/provider.ts";
import { post, setup } from "./helpers.ts";

const W = ["2026-03-01T00:00:00Z", "2026-03-31T23:59:59Z"] as const;

function pageOf(id: string, nextCursor: string): ProviderPage {
  const p = post(id, "2026-03-02T10:00:00Z");
  return {
    posts: [{ platformPostId: p.id, publishedAt: p.publishedAt, observedAt: p.observedAt!, views: p.views, likes: p.likes, comments: p.comments, shares: p.shares }],
    nextCursor,
  };
}

/** Se a proteção sumir, o teste falha rápido em vez de girar para sempre. */
function guarded(calls: number, page: ProviderPage): ProviderPage {
  if (calls > 20) throw new Error("loop de paginação sem proteção");
  return page;
}

describe("proteções de paginação", () => {
  it("provedor que sempre devolve o mesmo nextCursor: failed após 2 chamadas", async () => {
    let calls = 0;
    const provider: SocialProvider = { fetchPosts: async () => guarded(++calls, pageOf("a", "mesmo")) };
    const t = setup(provider);
    const out = await t.sync(...W);
    expect(out.status).toBe("failed");
    expect(out.error).toContain("Provedor repetiu o cursor");
    expect(calls).toBe(2);
  });

  it("maxPages: provedor de cursores sempre novos termina failed no teto", async () => {
    let calls = 0;
    const provider: SocialProvider = { fetchPosts: async () => guarded(++calls, pageOf("a", `c${calls}`)) };
    const t = setup(provider, { maxPages: 2 });
    const out = await t.sync(...W);
    expect(out.status).toBe("failed");
    expect(out.error).toContain("Limite de páginas");
    expect(out.pagesFetched).toBe(2);
    expect(calls).toBe(2);
  });
});
