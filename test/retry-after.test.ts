import { describe, expect, it } from "vitest";
import { parseRetryAfterMs } from "../src/retry-after.ts";

const now = new Date("2026-03-10T12:00:00.000Z");

describe("parseRetryAfterMs", () => {
  it("converte segundos em milissegundos", () => {
    expect(parseRetryAfterMs("2", now)).toBe(2000);
    expect(parseRetryAfterMs("0", now)).toBe(0);
  });

  it("converte data HTTP em diferença para o relógio", () => {
    expect(parseRetryAfterMs("Tue, 10 Mar 2026 12:00:05 GMT", now)).toBe(5000);
  });

  it("data no passado vira espera zero", () => {
    expect(parseRetryAfterMs("Tue, 10 Mar 2026 11:00:00 GMT", now)).toBe(0);
  });

  it("ausente ou inválido devolve null", () => {
    expect(parseRetryAfterMs(null, now)).toBeNull();
    expect(parseRetryAfterMs("", now)).toBeNull();
    expect(parseRetryAfterMs("logo", now)).toBeNull();
    expect(parseRetryAfterMs("-3", now)).toBeNull();
  });
});
