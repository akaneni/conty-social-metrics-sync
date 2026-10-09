// Provedor simulado. Este é o ÚNICO lugar que conhece o formato de resposta
// "de fio" do provedor falso; ele traduz para os tipos de ../provider.ts.
import type { FetchPostsParams, ProviderPage, ProviderPost, SocialProvider } from "../provider.ts";
import { PermanentProviderError, RateLimitedError, TransientProviderError } from "../provider.ts";

/** Post como o provedor falso o guarda. */
export interface SimulatedPost {
  id: string;
  publishedAt: string;
  /** Quando a métrica foi lida. Se omitido, usa o relógio do provedor. */
  observedAt?: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
}

/** Falha roteirizada, consumida uma por chamada, na ordem. */
export type Fault =
  | { kind: "timeout" }
  | { kind: "server_error"; status?: number }
  | { kind: "truncated" }
  | { kind: "rate_limit"; retryAfter?: string }
  | { kind: "unauthorized" }
  | { kind: "ok" };

// Formato de fio (inventado): campos e nomes diferentes do domínio de propósito.
interface WireItem {
  id: string;
  ts: number; // epoch ms de publicação
  read_at: number; // epoch ms da leitura da métrica
  stats: { view_count: number; like_count: number; comment_count: number; share_count: number };
}
interface WireResponse {
  data?: WireItem[];
  paging?: { next: string | null };
  complete?: boolean;
}

export interface SimulatedOptions {
  pageSize?: number;
  /** Repete o último item de cada página na página seguinte (resposta duplicada). */
  duplicatePosts?: boolean;
  faults?: Fault[];
  validToken?: string;
  now?: () => Date;
}

export class SimulatedProvider implements SocialProvider {
  public calls = 0;
  private faults: Fault[];
  private posts: SimulatedPost[];

  constructor(
    posts: SimulatedPost[],
    private readonly opts: SimulatedOptions = {},
  ) {
    this.posts = [...posts];
    this.faults = [...(opts.faults ?? [])];
  }

  setPosts(posts: SimulatedPost[]): void {
    this.posts = [...posts];
  }

  queueFaults(...faults: Fault[]): void {
    this.faults.push(...faults);
  }

  async fetchPosts(params: FetchPostsParams): Promise<ProviderPage> {
    this.calls++;
    const fault = this.faults.shift();
    if (this.opts.validToken !== undefined && params.token !== this.opts.validToken) {
      throw new PermanentProviderError(401, "token inválido");
    }
    if (fault) this.applyFault(fault);
    const wire = this.respond(params);
    return fromWire(wire);
  }

  private applyFault(fault: Fault): void {
    switch (fault.kind) {
      case "timeout":
        throw new TransientProviderError("timeout", "tempo esgotado");
      case "server_error":
        throw new TransientProviderError("server_error", `HTTP ${fault.status ?? 503}`);
      case "rate_limit":
        throw new RateLimitedError(fault.retryAfter ?? null);
      case "unauthorized":
        throw new PermanentProviderError(401, "token inválido");
      case "truncated":
        // Resposta cortada: o parse do corpo falha e vira falha transitória.
        fromWire({ data: [], complete: false });
        break;
      case "ok":
        break;
    }
  }

  private respond(params: FetchPostsParams): WireResponse {
    const since = Date.parse(params.since);
    const until = Date.parse(params.until);
    const inWindow = this.posts
      .filter((p) => {
        const t = Date.parse(p.publishedAt);
        return t >= since && t <= until;
      })
      .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.id.localeCompare(b.id));
    const size = this.opts.pageSize ?? 50;
    const start = params.cursor === null ? 0 : Number(params.cursor.replace("c", ""));
    let slice = inWindow.slice(start, start + size);
    if (this.opts.duplicatePosts && start > 0) slice = [inWindow[start - 1]!, ...slice];
    const end = start + size;
    const readAt = (this.opts.now ?? (() => new Date()))().getTime();
    return {
      complete: true,
      data: slice.map((p) => ({
        id: p.id,
        ts: Date.parse(p.publishedAt),
        read_at: p.observedAt ? Date.parse(p.observedAt) : readAt,
        stats: { view_count: p.views, like_count: p.likes, comment_count: p.comments, share_count: p.shares },
      })),
      paging: { next: end < inWindow.length ? `c${end}` : null },
    };
  }
}

function fromWire(wire: WireResponse): ProviderPage {
  if (wire.complete === false || !wire.data) {
    throw new TransientProviderError("truncated", "resposta truncada");
  }
  const posts: ProviderPost[] = wire.data.map((w) => ({
    platformPostId: w.id,
    publishedAt: new Date(w.ts).toISOString(),
    observedAt: new Date(w.read_at).toISOString(),
    views: w.stats.view_count,
    likes: w.stats.like_count,
    comments: w.stats.comment_count,
    shares: w.stats.share_count,
  }));
  return { posts, nextCursor: wire.paging?.next ?? null };
}

/** Dados para `npm run dev`. A leitura é fixada na subida: repetir a sync não traz leitura nova. */
export function demoPosts(count = 7, now: Date = new Date()): SimulatedPost[] {
  const day = 86_400_000;
  return Array.from({ length: count }, (_, i) => ({
    id: `post_${i + 1}`,
    publishedAt: new Date(now.getTime() - (count - i) * day).toISOString(),
    observedAt: now.toISOString(),
    views: 1000 * (i + 1),
    likes: 100 * (i + 1),
    comments: 10 * (i + 1),
    shares: 5 * (i + 1),
  }));
}
