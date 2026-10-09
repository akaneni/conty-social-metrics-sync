// Fronteira entre a regra de negócio e o provedor das redes.
// A regra de negócio (sync.ts, db.ts, app.ts) só conhece este arquivo.
// O formato de resposta de cada provedor fica dentro da implementação.

export type Platform = "instagram" | "tiktok" | "youtube" | "x";

export const PLATFORMS: readonly Platform[] = ["instagram", "tiktok", "youtube", "x"];

/** Métrica de um post, já normalizada, observada em `observedAt` (ISO UTC). */
export interface ProviderPost {
  platformPostId: string;
  publishedAt: string;
  observedAt: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
}

export interface FetchPostsParams {
  token: string;
  platform: Platform;
  since: string;
  until: string;
  cursor: string | null;
}

export interface ProviderPage {
  posts: ProviderPost[];
  nextCursor: string | null;
}

export interface SocialProvider {
  /** Lança TransientProviderError, RateLimitedError ou PermanentProviderError. */
  fetchPosts(params: FetchPostsParams): Promise<ProviderPage>;
}

/** Timeout, 5xx ou resposta truncada: vale tentar de novo. */
export class TransientProviderError extends Error {
  constructor(
    public readonly kind: "timeout" | "server_error" | "truncated",
    message: string,
  ) {
    super(message);
  }
}

/** 429. `retryAfter` é o valor cru do header (segundos ou data HTTP), se vier. */
export class RateLimitedError extends Error {
  constructor(public readonly retryAfter: string | null) {
    super("Provedor respondeu 429");
  }
}

/** 4xx que não adianta repetir (token inválido, sem permissão, conexão inexistente). */
export class PermanentProviderError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
