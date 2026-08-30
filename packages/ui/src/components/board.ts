import { html } from 'hono/html';
import { formatCount } from '@tsbb/core';
import type { Forum, Topic, User, Viewer } from '@tsbb/plugin-api';
import { Avatar, Badge, TimeAgo, trusted } from './primitives.ts';
import { IconCheck, IconFolder, IconLock, IconPin, IconQuote, IconReply } from './icons.ts';

export interface LastPostSummary {
  postId: number;
  topicId: number;
  topicTitle: string;
  topicSlug: string;
  createdAt: number;
  authorName: string | null;
}

export interface ForumRowNode extends Forum {
  children: ForumRowNode[];
  lastPost: LastPostSummary | null;
  unread?: boolean;
}

/**
 * The accent hue is passed in rather than chosen by :nth-child, because
 * nth-child counts within one card — so a board with several categories
 * restarts at the first hue in each and only ever shows the first few.
 */
export function ForumRow(forum: ForumRowNode, hue = 0) {
  const href = forum.kind === 'link' ? (forum.linkUrl ?? '#') : `/f/${forum.slug}`;
  const tone = `tone-${(hue % 6) + 1}`;
  return html`<div class="${['forum-row', forum.unread ? 'unread' : '', tone].filter(Boolean).join(' ')}">
    <span class="forum-icon" aria-hidden="true">${IconFolder()}</span>
    <div class="grow">
      <a class="forum-name" href="${href}">${forum.name}</a>
      ${forum.isLocked ? html` <span class="muted tiny">${IconLock()} locked</span>` : ''}
      ${forum.description ? html`<div class="forum-desc">${forum.description}</div>` : ''}
      ${forum.children.length
        ? html`<div class="topic-sub">
            ${forum.children.map(
              (child, i) =>
                html`${i > 0 ? html`<span aria-hidden="true">·</span>` : ''}<a href="/f/${child.slug}"
                  >${child.name}</a
                >`,
            )}
          </div>`
        : ''}
    </div>
    <div class="forum-meta">
      <div class="forum-stat"><strong>${formatCount(forum.topicCount)}</strong>topics</div>
      <div class="forum-stat"><strong>${formatCount(forum.postCount)}</strong>posts</div>
      ${forum.lastPost
        ? html`<div class="forum-last">
            <a
              class="forum-last-title"
              href="/t/${forum.lastPost.topicSlug}-${forum.lastPost.topicId}/p/${forum.lastPost.postId}"
              >${forum.lastPost.topicTitle}</a
            >
            <span class="tiny muted"
              >${forum.lastPost.authorName
                ? html`by <a href="/u/${forum.lastPost.authorName}">${forum.lastPost.authorName}</a> `
                : ''}${TimeAgo(forum.lastPost.createdAt)}</span
            >
          </div>`
        : html`<div class="forum-last tiny muted">No posts yet</div>`}
    </div>
  </div>`;
}

export interface TopicRowItem extends Topic {
  authorName: string | null;
  lastPosterName: string | null;
  unread: boolean;
  hasPoll: boolean;
}

export function TopicRow(topic: TopicRowItem) {
  return html`<div class="${topic.unread ? 'topic-row unread' : 'topic-row'}">
    <span class="avatar avatar-sm" aria-hidden="true"
      ><span class="avatar-fallback">${(topic.authorName ?? '?').slice(0, 1).toUpperCase()}</span></span
    >
    <div class="grow">
      <span class="topic-tags">
        ${topic.kind === 'announcement' || topic.kind === 'global' ? Badge('Announcement', 'destructive') : ''}
        ${topic.kind === 'sticky' ? Badge(html`${IconPin()} Pinned`, 'warning') : ''}
        ${topic.isLocked ? Badge(html`${IconLock()} Locked`, 'outline') : ''}
        ${topic.isSolved ? Badge(html`${IconCheck()} Solved`, 'success') : ''}
        ${topic.hasPoll ? Badge('Poll', 'secondary') : ''}
      </span>
      <a class="topic-title" href="/t/${topic.slug}-${topic.id}">${topic.title}</a>
      <div class="topic-sub">
        ${topic.authorName
          ? html`<a href="/u/${topic.authorName}">${topic.authorName}</a><span class="dot" aria-hidden="true"></span>`
          : ''}${TimeAgo(topic.createdAt)}
      </div>
    </div>
    <div class="topic-meta">
      <div class="topic-count"><strong>${formatCount(topic.replyCount)}</strong><span>replies</span></div>
      <div class="topic-count"><strong>${formatCount(topic.viewCount)}</strong><span>views</span></div>
      <div class="nowrap">
        ${TimeAgo(topic.lastPostAt ?? topic.createdAt)}
        ${topic.lastPosterName
          ? html`<div class="tiny">by <a href="/u/${topic.lastPosterName}">${topic.lastPosterName}</a></div>`
          : ''}
      </div>
    </div>
  </div>`;
}

export interface PostAuthorView
  extends Pick<User, 'id' | 'username' | 'email' | 'avatarKind' | 'avatarUrl'> {
  displayName: string | null;
  title: string | null;
  postCount: number;
  createdAt: number | null;
  isAdmin: boolean;
  isModerator: boolean;
  rank: string | null;
}

export interface PostView {
  id: number;
  bodyHtml: string;
  /**
   * Null when the author has not earned a signature yet. The rule lives in
   * core's signatureGate; this renders only what it is handed, so there is no
   * second place for the threshold to drift out of step.
   */
  signatureHtml: string | null;
  createdAt: number;
  editedAt: number | null;
  editCount: number;
  isHidden: boolean;
  isSolution: boolean;
  reactionCount: number;
  viewerReacted: boolean;
  author: PostAuthorView | null;
  canEdit: boolean;
  canDelete: boolean;
  canModerate: boolean;
  /** Plugin output for the post:byline and post:footer slots. */
  slots?: { byline?: string; footer?: string };
}

export function PostArticle(options: {
  post: PostView;
  topicSlug: string;
  topicId: number;
  viewer: Viewer;
  number: number;
}) {
  const { post, topicSlug, topicId, viewer } = options;
  const permalink = `/t/${topicSlug}-${topicId}/p/${post.id}`;
  const classNames = ['post', post.isHidden ? 'is-hidden' : '', post.isSolution ? 'is-solution' : '']
    .filter(Boolean)
    .join(' ');

  return html`<article class="${classNames}" id="p${post.id}">
    <div class="post-author">
      ${post.author
        ? html`${Avatar(post.author, 'lg')}
            <div>
              <a class="post-author-name" href="/u/${post.author.username}"
                >${post.author.displayName ?? post.author.username}</a
              >
              ${post.author.isAdmin
                ? html`<div>${Badge('Admin', 'staff')}</div>`
                : post.author.isModerator
                  ? html`<div>${Badge('Moderator', 'staff')}</div>`
                  : post.author.rank
                    ? html`<div class="post-author-title">${post.author.rank}</div>`
                    : ''}
              ${post.author.title ? html`<div class="post-author-title">${post.author.title}</div>` : ''}
              <div class="post-author-stats">
                ${formatCount(post.author.postCount)} post${post.author.postCount === 1 ? '' : 's'}
                ${post.author.createdAt ? html`<br />joined ${TimeAgo(post.author.createdAt)}` : ''}
              </div>
            </div>`
        : html`<div class="muted small">Deleted account</div>`}
    </div>

    <div class="post-main">
      <div class="post-header">
        <span>
          ${TimeAgo(post.createdAt)}
          ${post.editCount > 0 && post.editedAt ? html`<span class="muted"> · edited ${TimeAgo(post.editedAt)}</span>` : ''}
          ${post.isHidden ? html`<span class="muted"> · hidden by a moderator</span>` : ''}
        </span>
        <span class="row">${trusted(post.slots?.byline)}<a class="post-permalink" href="${permalink}">#${options.number}</a></span>
      </div>

      <div class="post-body">${trusted(post.bodyHtml)}</div>

      ${post.signatureHtml ? html`<div class="post-signature">${trusted(post.signatureHtml)}</div>` : ''}

      <div class="post-footer">
        <div class="post-actions">
          ${viewer.user
            ? html`<form action="/p/${post.id}/react" method="post">
                  <button class="${post.viewerReacted ? 'btn btn-secondary btn-sm' : 'btn btn-ghost btn-sm'}" type="submit">
                    ♥ ${post.reactionCount > 0 ? post.reactionCount : ''}
                  </button>
                </form>
                <a class="btn btn-ghost btn-sm" href="/t/${topicSlug}-${topicId}/reply?to=${post.id}">${IconReply()} Reply</a>
                <a class="btn btn-ghost btn-sm" href="/t/${topicSlug}-${topicId}/reply?quote=${post.id}">${IconQuote()} Quote</a>`
            : post.reactionCount > 0
              ? html`<span class="btn btn-ghost btn-sm" aria-disabled="true">♥ ${post.reactionCount}</span>`
              : ''}
        </div>
        <div class="post-actions">
          ${trusted(post.slots?.footer)}
          ${post.canEdit ? html`<a class="btn btn-ghost btn-sm" href="/p/${post.id}/edit">Edit</a>` : ''}
          ${post.canDelete
            ? html`<form action="/p/${post.id}/delete" method="post">
                <button class="btn btn-ghost btn-sm" type="submit">Delete</button>
              </form>`
            : ''}
          ${viewer.user && !post.canModerate
            ? html`<a class="btn btn-ghost btn-sm" href="/p/${post.id}/report">Report</a>`
            : ''}
        </div>
      </div>
    </div>
  </article>`;
}
