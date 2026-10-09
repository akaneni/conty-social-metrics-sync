/**
 * Converte o valor do header Retry-After em milissegundos de espera.
 * Aceita segundos inteiros ou data HTTP. Devolve null se ausente ou inválido.
 */
export function parseRetryAfterMs(raw: string | null, now: Date): number | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (value === "") return null;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!/[a-z]/i.test(value)) return null;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now.getTime());
}
