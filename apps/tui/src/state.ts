import type { ForumNode, Me, PostView, TopicSummary } from './client.ts';

export type ScreenName =
  | 'forums'
  | 'topics'
  | 'topic'
  | 'search'
  | 'notifications'
  | 'compose'
  | 'login'
  | 'help';

export interface ComposeState {
  kind: 'reply' | 'topic';
  topicId?: number;
  forumSlug?: string;
  title: string;
  body: string;
  /** Which field the keyboard is editing. */
  field: 'title' | 'body';
}

export interface NotificationRow {
  id: number;
  kind: string;
  title: string | null;
  excerpt: string | null;
  url: string | null;
  readAt: number | null;
  createdAt: number;
}

export interface SearchHit {
  postId: number;
  topicId: number;
  title: string;
  author: string | null;
  snippet: string;
  url: string;
}

export interface LoginState {
  userCode: string;
  verifyUrl: string;
  expiresAt: number;
}

/**
 * One flat object for the whole client.
 *
 * Views are pure functions of it, which is what makes them testable without a
 * terminal: hqtui's renderToText takes the same view function the real app
 * does, so a snapshot test exercises the actual layout rather than a stand-in.
 */
export interface State {
  server: string;
  boardName: string;
  me: Me | null;

  screen: ScreenName;
  /** Where each screen was left, so going back does not lose your place. */
  history: ScreenName[];

  forums: { node: ForumNode; depth: number }[];
  topics: TopicSummary[];
  topicTitle: string;
  forumName: string;
  forumSlug: string;

  posts: PostView[];
  topic: TopicSummary | null;
  canReply: boolean;

  notifications: NotificationRow[];
  hits: SearchHit[];
  query: string;

  compose: ComposeState | null;
  login: LoginState | null;

  selected: number;
  scroll: number;
  status: string;
  error: string | null;
  loading: boolean;
}

export function initialState(server: string): State {
  return {
    server,
    boardName: 'tsbb',
    me: null,
    screen: 'forums',
    history: [],
    forums: [],
    topics: [],
    topicTitle: '',
    forumName: '',
    forumSlug: '',
    posts: [],
    topic: null,
    canReply: false,
    notifications: [],
    hits: [],
    query: '',
    compose: null,
    login: null,
    selected: 0,
    scroll: 0,
    status: 'Loading…',
    error: null,
    loading: true,
  };
}

/** Flatten the forum tree for a list, keeping categories as headings. */
export function flattenForums(nodes: ForumNode[], depth = 0): { node: ForumNode; depth: number }[] {
  const out: { node: ForumNode; depth: number }[] = [];
  for (const node of nodes) {
    out.push({ node, depth });
    if (node.children.length) out.push(...flattenForums(node.children, depth + 1));
  }
  return out;
}

/** How many rows the current screen can be scrolled through. */
export function rowCount(state: State): number {
  switch (state.screen) {
    case 'forums':
      return state.forums.filter((f) => f.node.kind !== 'category').length;
    case 'topics':
      return state.topics.length;
    case 'topic':
      return state.posts.length;
    case 'notifications':
      return state.notifications.length;
    case 'search':
      return state.hits.length;
    default:
      return 0;
  }
}

export function clampSelection(state: State): void {
  const total = rowCount(state);
  if (total === 0) {
    state.selected = 0;
    return;
  }
  state.selected = Math.min(Math.max(0, state.selected), total - 1);
}
