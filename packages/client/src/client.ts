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

export interface SearchHit {
  postId: number;
  topicId: number;
  title: string;
  author: string | null;
  createdAt: number;
  snippet: string;
  url: string;
}

export interface Notification {
  id: number;
  kind: string;
  title: string | null;
  excerpt: string | null;
  url: string | null;
  readAt: number | null;
  createdAt: number;
}

/** A forum as the flat list returns it — the tree, with depth instead of nesting. */
export interface ForumRow {
  id: number;
  slug: string;
  name: string;
  kind: string;
  description: string | null;
  depth: number;
  topics: number;
  posts: number;
  url: string;
}

export interface Profile {
  id: number;
  username: string;
  displayName: string | null;
  title: string | null;
  bio: string | null;
  postCount: number;
  createdAt: number;
  lastSeenAt: number | null;
  isModerator: boolean;
  url: string;
}

export interface BoardStats {
  board: { name: string; tagline: string; url: string };
  members: number;
  topics: number;
  posts: number;
  newestMember: string | null;
  latestPostAt: number | null;
}

/**
 * What `GET /api/v1` answers: enough for a client to find everything else,
 * including whether this board speaks MCP and at which URL.
 */
export interface ApiIndex {
  api: string;
  version: string;
  board: { name: string; tagline: string; url: string };
  authenticated: boolean;
  auth: { scheme: string; deviceFlow: string };
  endpoints: Record<string, string>;
  mcp: { endpoint: string; transport: string; tools: number };
  openapi: string;
  docs: string;
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

  /** The self-describing index. A client points at a URL and asks what it is. */
  index() {
    return this.request<ApiIndex>('/api/v1');
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

  /** Every forum the viewer may see, flattened — what a script wants to iterate. */
  forums() {
    return this.request<{ forums: ForumRow[] }>('/api/v1/forums');
  }

  /** One post on its own, with the topic it belongs to for context. */
  post(id: number) {
    return this.request<{
      post: PostView;
      topic: { id: number; slug: string; title: string };
      url: string;
    }>(`/api/v1/posts/${id}`);
  }

  user(username: string) {
    return this.request<{ user: Profile }>(`/api/v1/users/${encodeURIComponent(username)}`);
  }

  stats() {
    return this.request<BoardStats>('/api/v1/stats');
  }

  search(query: string, limit = 30) {
    return this.request<{ query: string; hits: SearchHit[] }>(
      `/api/v1/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    );
  }

  notifications(limit = 40) {
    return this.request<{ unread: number; notifications: Notification[] }>(
      `/api/v1/notifications?limit=${limit}`,
    );
  }

  markNotificationsRead() {
    return this.request<{ ok: true }>('/api/v1/notifications/read', { method: 'POST' });
  }

  /** Mark every topic in every readable forum read, as of now. */
  markBoardRead() {
    return this.request<{ ok: true }>('/api/v1/read', { method: 'POST' });
  }

  /** Mark every topic in one forum and its subforums read, as of now. */
  markForumRead(slug: string) {
    return this.request<{ ok: true }>(`/api/v1/forums/${encodeURIComponent(slug)}/read`, {
      method: 'POST',
    });
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
