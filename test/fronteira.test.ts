import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("../src/", import.meta.url).pathname;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe("fronteira com o provedor simulado", () => {
  it("a regra de negócio nunca importa o provedor simulado, só a interface", () => {
    const business = files(SRC).filter((f) => !f.includes("/providers/") && !f.endsWith("/index.ts"));
    expect(business.length).toBeGreaterThan(3);
    for (const f of business) {
      const imports = [...readFileSync(f, "utf8").matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      expect(imports.filter((i) => i!.includes("providers/") || i!.includes("simulated")), f).toEqual([]);
    }
  });

  it("o provedor simulado só depende da interface, nunca da regra de sync ou do banco", () => {
    const imports = [...readFileSync(join(SRC, "providers/simulated.ts"), "utf8").matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports).toEqual(["../provider.ts", "../provider.ts"]);
  });

  it("sync.ts não importa Hono nem node:sqlite (sem HTTP nem SQL na regra)", () => {
    const src = readFileSync(join(SRC, "sync.ts"), "utf8");
    expect(src).not.toMatch(/from\s+"(hono|node:sqlite)"/);
    expect(src).not.toMatch(/Date\.now\(|new Date\(\)/);
  });
});
