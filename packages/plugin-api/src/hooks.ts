import type { Forum, Id, Post, PostDraft, Permissions, Topic, User, Viewer } from './entities.ts';

/**
 * Three extension mechanisms, deliberately distinct:
 *
 *   filters  transform a value and must return one       (pure-ish, ordered)
 *   actions  observe something that happened             (side effects, awaited)
 *   slots    contribute markup at a named place in a page
 *
 * A plugin that wants to *change* what the board does uses a filter; one that
 * wants to *react* uses an action. Keeping them apart means a slow webhook in
 * an action can never silently corrupt a render, and a filter that throws is a
 * bug rather than a half-applied side effect.
 */

/** Anything that can be turned into HTML. Hono's JSX elements qualify. */
export type SlotNode = string | { toString(): string } | null | undefined;

export interface RenderContext {
  viewer: Viewer;
  url: URL;
  /** Board settings, already resolved. */
  settings: Record<string, unknown>;
}

/**
 * Filters. Each entry names the value being transformed and the context handed
 * alongside it. Plugins may add their own by augmenting this interface.
 */
export interface FilterMap {
  /** Rendered HTML of a post body, after the markup pipeline. */
  'post:render': { value: string; ctx: { post: Post; author: User | null; viewer: Viewer } };
  /** Rendered HTML of a user signature, after gating and the markup pipeline. */
  'signature:render': { value: string; ctx: { author: User; viewer: Viewer } };
  /** A post about to be written. Return it changed, or throw to refuse it. */
  'post:before_save': { value: PostDraft; ctx: { viewer: Viewer; isEdit: boolean } };
  /** A topic title about to be written. */
  'topic:before_save': { value: string; ctx: { viewer: Viewer; forum: Forum } };
  /** Effective permissions for a viewer on a forum, after group resolution. */
  'permissions:resolve': { value: Permissions; ctx: { viewer: Viewer; forum: Forum | null } };
  /** Extra tags for <head>. Return the array, appended to or replaced. */
  'page:head': { value: SlotNode[]; ctx: RenderContext };
  /** Primary navigation items. */
  'nav:items': { value: NavItem[]; ctx: RenderContext };
  /** The number of posts before a signature is shown. Default 10. */
  'signature:min_posts': { value: number; ctx: { author: User } };
  /** Recipients of a notification, after subscription fan-out and blocking. */
  'notify:recipients': { value: Id[]; ctx: { kind: string; subjectType: string; subjectId: Id } };
  /** A queued email, immediately before the transport takes it. */
  'mail:before_send': {
    value: { to: string; subject: string; html: string; text: string };
    ctx: { kind: string; userId: Id | null };
  };
  /** The Content-Security-Policy header value for a page response. */
  'security:csp': { value: CspDirectives; ctx: RenderContext };
}

/** Actions. The payload is handed to every listener; return values are ignored. */
export interface ActionMap {
  boot: { startedAt: number };
  shutdown: Record<string, never>;
  'post:created': { post: Post; topic: Topic; viewer: Viewer };
  'post:updated': { post: Post; previousBody: string; viewer: Viewer };
  'post:deleted': { postId: Id; topicId: Id; viewer: Viewer };
  'topic:created': { topic: Topic; forum: Forum; viewer: Viewer };
  'topic:locked': { topic: Topic; viewer: Viewer };
  'topic:moved': { topic: Topic; fromForumId: Id; toForumId: Id; viewer: Viewer };
  'user:registered': { user: User };
  'user:login': { user: User; method: 'magic-link' | 'passkey' | 'token' };
  'user:banned': { user: User; reason: string | null; viewer: Viewer };
  'report:created': { reportId: Id; targetType: string; targetId: Id };
  'reaction:added': { postId: Id; userId: Id; kind: string };
}

/**
 * Named places a plugin can render into. The props are what that place knows;
 * anything else the plugin needs it fetches itself.
 */
export interface SlotMap {
  'layout:head': RenderContext;
  'layout:header': RenderContext;
  'layout:body_start': RenderContext;
  'layout:body_end': RenderContext;
  'layout:footer': RenderContext;
  // There is no layout:sidebar. The board has no sidebar to render into, and a
  // slot with nowhere to go is worse than no slot: a plugin registers for it,
  // nothing appears, and nothing says why.
  'board:above_categories': RenderContext;
  'board:below_categories': RenderContext;
  'forum:above_topics': RenderContext & { forum: Forum };
  'forum:below_topics': RenderContext & { forum: Forum };
  'topic:above_posts': RenderContext & { topic: Topic; forum: Forum };
  'topic:between_posts': RenderContext & { topic: Topic; index: number; total: number };
  'topic:below_posts': RenderContext & { topic: Topic; forum: Forum };
  'post:byline': RenderContext & { post: Post; author: User | null };
  'post:footer': RenderContext & { post: Post; author: User | null };
  'profile:tabs': RenderContext & { profile: User };
  'composer:toolbar': RenderContext;
  'admin:nav': RenderContext;
}

export interface NavItem {
  label: string;
  href: string;
  /** Higher sorts later. Core items sit at 0, 10, 20 … so a plugin can slot in. */
  weight?: number;
  match?: string;
  badge?: number | string | null;
  requires?: 'guest' | 'user' | 'moderator' | 'admin';
}

export interface CspDirectives {
  [directive: string]: string[];
}

export type FilterName = keyof FilterMap & string;
export type ActionName = keyof ActionMap & string;
export type SlotName = keyof SlotMap & string;

export type FilterHandler<K extends FilterName> = (
  value: FilterMap[K]['value'],
  ctx: FilterMap[K]['ctx'],
) => FilterMap[K]['value'] | Promise<FilterMap[K]['value']>;

export type ActionHandler<K extends ActionName> = (payload: ActionMap[K]) => void | Promise<void>;

export type SlotHandler<K extends SlotName> = (props: SlotMap[K]) => SlotNode | Promise<SlotNode>;
