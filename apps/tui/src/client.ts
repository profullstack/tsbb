/**
 * A client for a *centralised* tsbb install.
 *
 * The terminal holds no database and no session — everything it shows comes
 * from one remote board over its REST API, authenticated with a bearer token.
 * That is what makes it a client rather than a second implementation of the
 * board: it can only ever see and do what the API would let a browser do.
 */

export interface ClientOptions {
  server: string;
  token?: string | null;
  fetch?: typeof fetch;
}

export interface Me {
  authenticated: boolean;
  user?: { id: number; username: string; displayName: string | null; postCount: number };
  unread?: number;
}

export interface ForumNode {
  id: number;
  slug: string;
  name: string;
  kind: string;
  description: string | null;
  topics: number;
  posts: number;
  children: ForumNode[];
}

export interface TopicSummary {
  id: number;
  slug: string;
  title: string;
  kind: string;
  locked: boolean;
  solved: boolean;
  replies: number;
  views: number;
  createdAt: number;
  lastPostAt: number | null;
  author: string | null;
  lastPoster: string | null;
  unread: boolean;
  url: string;
}

export interface PostView {
  id: number;
  author: string | null;
  authorTitle: string | null;
  createdAt: number;
  editedAt: number | null;
  format: string;
  body: string;
  text: string;
  reactions: number;
}

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export class BoardClient {
  #server: string;
  #token: string | null;
  #fetch: typeof fetch;

  constructor(options: ClientOptions) {
    // A trailing slash turns every path into a double slash, which some proxies
    // answer with a redirect the client then has to follow.
    this.#server = options.server.replace(/\/+$/, '');
    this.#token = options.token ?? null;
    this.#fetch = options.fetch ?? fetch;
  }

  get server(): string {
    return this.#server;
  }

  setToken(token: string | null): void {
    this.#token = token;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    if (init.body) headers.set('content-type', 'application/json');
    if (this.#token) headers.set('authorization', `Bearer ${this.#token}`);

    let response: Response;
    try {
      response = await this.#fetch(`${this.#server}${path}`, { ...init, headers });
    } catch (error) {
      // A connection failure is the single most common thing to go wrong here,
      // and "fetch failed" tells the reader nothing about which board.
      throw new ApiError(0, 'unreachable', `Cannot reach ${this.#server}: ${(error as Error).message}`);
    }

    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw new ApiError(
        response.status,
        'not_json',
        `${this.#server} answered with ${response.status} and something that is not JSON. Is this a tsbb board?`,
      );
    }

    if (!response.ok) {
      const body = payload as { error?: string; message?: string } | null;
      throw new ApiError(
        response.status,
        body?.error ?? 'error',
        body?.message ?? `${init.method ?? 'GET'} ${path} failed with ${response.status}`,
      );
    }
    return payload as T;
  }

  me() {
    return this.request<Me>('/api/v1/me');
  }

  board() {
    return this.request<{ board: { name: string; tagline: string }; forums: ForumNode[] }>(
      '/api/v1/board',
    );
  }

  latest(limit = 40) {
    return this.request<{ topics: TopicSummary[] }>(`/api/v1/latest?limit=${limit}`);
  }

  topics(slug: string, limit = 40) {
    return this.request<{ forum: { name: string }; topics: TopicSummary[] }>(
      `/api/v1/forums/${encodeURIComponent(slug)}/topics?limit=${limit}`,
    );
  }

  topic(id: number, limit = 50) {
    return this.request<{
      topic: TopicSummary;
      forum: { slug: string; name: string };
      canReply: boolean;
      posts: PostView[];
    }>(`/api/v1/topics/${id}?limit=${limit}`);
  }

  reply(topicId: number, body: string) {
    return this.request<{ id: number; url: string }>(`/api/v1/topics/${topicId}/posts`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  }

  newTopic(slug: string, title: string, body: string) {
    return this.request<{ id: number; slug: string; url: string }>(
      `/api/v1/forums/${encodeURIComponent(slug)}/topics`,
      { method: 'POST', body: JSON.stringify({ title, body }) },
    );
  }

  search(query: string) {
    return this.request<{
      hits: { postId: number; topicId: number; title: string; author: string | null; snippet: string; url: string }[];
    }>(`/api/v1/search?q=${encodeURIComponent(query)}`);
  }

  notifications() {
    return this.request<{
      unread: number;
      notifications: { id: number; kind: string; title: string | null; excerpt: string | null; url: string | null; readAt: number | null; createdAt: number }[];
    }>('/api/v1/notifications?limit=40');
  }

  markNotificationsRead() {
    return this.request<{ ok: true }>('/api/v1/notifications/read', { method: 'POST' });
  }

  startDeviceAuth(label: string) {
    return this.request<{
      deviceCode: string;
      userCode: string;
      verifyUrl: string;
      expiresAt: number;
      interval: number;
    }>('/api/v1/device/start', { method: 'POST', body: JSON.stringify({ label, publicKey: 'none' }) });
  }

  pollDeviceAuth(deviceCode: string) {
    return this.request<{ status: 'pending' | 'approved' | 'expired'; token?: string }>(
      '/api/v1/device/poll',
      { method: 'POST', body: JSON.stringify({ deviceCode }) },
    );
  }
}
