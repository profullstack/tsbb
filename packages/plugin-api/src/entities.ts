/**
 * The shapes a plugin sees. These are the leaf types of the whole codebase:
 * core imports them from here rather than the other way round, so a plugin can
 * depend on `@tsbb/plugin-api` alone.
 */

export type Id = number;
export type Timestamp = number;

export type BodyFormat = 'markdown' | 'bbcode';
export type ForumKind = 'category' | 'forum' | 'link';
/**
 * Who may write in a forum, on top of group permissions:
 * 'topics' — members start topics and reply; 'replies' — members may only
 * reply, so topics come from feeds and staff; 'none' — members only read.
 */
export type MemberPosting = 'topics' | 'replies' | 'none';
export type TopicKind = 'normal' | 'sticky' | 'announcement' | 'global';
export type AvatarKind = 'none' | 'upload' | 'gravatar' | 'identicon';

export interface User {
  id: Id;
  username: string;
  displayName: string | null;
  email: string;
  avatarKind: AvatarKind;
  avatarUrl: string | null;
  signature: string | null;
  title: string | null;
  location: string | null;
  website: string | null;
  bio: string | null;
  timezone: string;
  locale: string;
  postCount: number;
  topicCount: number;
  reactionCount: number;
  isAdmin: boolean;
  isModerator: boolean;
  isBanned: boolean;
  createdAt: Timestamp;
  lastSeenAt: Timestamp | null;
}

export interface Forum {
  id: Id;
  parentId: Id | null;
  kind: ForumKind;
  slug: string;
  name: string;
  description: string | null;
  linkUrl: string | null;
  icon: string | null;
  colour: string | null;
  position: number;
  isLocked: boolean;
  isHidden: boolean;
  memberPosting: MemberPosting;
  topicCount: number;
  postCount: number;
  lastPostAt: Timestamp | null;
}

export interface Topic {
  id: Id;
  forumId: Id;
  userId: Id | null;
  title: string;
  slug: string;
  kind: TopicKind;
  isLocked: boolean;
  isHidden: boolean;
  isDeleted: boolean;
  isSolved: boolean;
  viewCount: number;
  replyCount: number;
  firstPostId: Id | null;
  lastPostId: Id | null;
  lastPostAt: Timestamp | null;
  bumpedAt: Timestamp;
  createdAt: Timestamp;
}

export interface Post {
  id: Id;
  topicId: Id;
  forumId: Id;
  userId: Id | null;
  replyToId: Id | null;
  body: string;
  bodyFormat: BodyFormat;
  position: number;
  isHidden: boolean;
  isDeleted: boolean;
  editCount: number;
  editedAt: Timestamp | null;
  createdAt: Timestamp;
}

/** A post on its way into the database, before it has an id. */
export interface PostDraft {
  topicId: Id;
  forumId: Id;
  userId: Id | null;
  replyToId: Id | null;
  body: string;
  bodyFormat: BodyFormat;
}

export interface Notification {
  id: Id;
  userId: Id;
  kind: string;
  actorId: Id | null;
  subjectType: string | null;
  subjectId: Id | null;
  url: string | null;
  title: string | null;
  excerpt: string | null;
  data: Record<string, unknown>;
  readAt: Timestamp | null;
  createdAt: Timestamp;
}

/** Who is asking, on any request. `user` is null for a guest. */
export interface Viewer {
  user: User | null;
  groupIds: Id[];
  isAdmin: boolean;
  isModerator: boolean;
  /** Set when the request arrived with an API token rather than a session. */
  viaToken: boolean;
}

export interface Permissions {
  canView: boolean;
  canRead: boolean;
  canPost: boolean;
  canReply: boolean;
  canEditOwn: boolean;
  canDeleteOwn: boolean;
  canAttach: boolean;
  canPoll: boolean;
  canModerate: boolean;
}
