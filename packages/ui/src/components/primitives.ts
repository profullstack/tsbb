import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import { avatarUrlFor, formatCount, relativeTime } from '@tsbb/core';
import type { User } from '@tsbb/plugin-api';

export type Renderable = HtmlEscapedString | Promise<HtmlEscapedString> | string | null | undefined;

/**
 * Interpolating a value into an `html` template escapes it. Anything already
 * rendered — a post body from the markup pipeline, a plugin's slot output —
 * goes through here instead, which is the single, greppable place where trusted
 * HTML enters a page.
 */
export function trusted(markup: string | null | undefined): HtmlEscapedString | string {
  return markup ? raw(markup) : '';
}

export function classes(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export type ButtonVariant = 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive' | 'link';
export type ButtonSize = 'sm' | 'default' | 'lg' | 'icon';

/** shadcn's Button variants, as a class string. */
export function buttonClass(
  variant: ButtonVariant = 'default',
  size: ButtonSize = 'default',
  extra?: string,
): string {
  return classes('btn', variant !== 'default' && `btn-${variant}`, size !== 'default' && `btn-${size}`, extra);
}

export interface ButtonOptions {
  variant?: ButtonVariant;
  size?: ButtonSize;
  class?: string;
  type?: 'button' | 'submit' | 'reset';
  name?: string;
  value?: string;
  title?: string;
  ariaLabel?: string;
  disabled?: boolean;
}

export function Button(label: Renderable, options: ButtonOptions = {}) {
  return html`<button
    type="${options.type ?? 'button'}"
    class="${buttonClass(options.variant, options.size, options.class)}"
    ${options.name ? raw(`name="${escapeAttribute(options.name)}"`) : ''}
    ${options.value ? raw(`value="${escapeAttribute(options.value)}"`) : ''}
    ${options.title ? raw(`title="${escapeAttribute(options.title)}"`) : ''}
    ${options.ariaLabel ? raw(`aria-label="${escapeAttribute(options.ariaLabel)}"`) : ''}
    ${options.disabled ? raw('disabled') : ''}
  >${label}</button>`;
}

export function LinkButton(label: Renderable, href: string, options: ButtonOptions = {}) {
  return html`<a href="${href}" class="${buttonClass(options.variant, options.size, options.class)}"
    ${options.ariaLabel ? raw(`aria-label="${escapeAttribute(options.ariaLabel)}"`) : ''}
    >${label}</a
  >`;
}

export type BadgeVariant =
  | 'default'
  | 'secondary'
  | 'outline'
  | 'destructive'
  | 'success'
  | 'warning'
  | 'staff';

export function Badge(label: Renderable, variant: BadgeVariant = 'default') {
  return html`<span class="${classes('badge', variant !== 'default' && `badge-${variant}`)}">${label}</span>`;
}

export function Card(body: Renderable, options: { class?: string } = {}) {
  return html`<div class="${classes('card', options.class)}">${body}</div>`;
}

export function CardHeader(title: Renderable, options: { description?: Renderable; actions?: Renderable } = {}) {
  return html`<div class="card-header">
    <div>
      <div class="card-title">${title}</div>
      ${options.description ? html`<div class="card-description">${options.description}</div>` : ''}
    </div>
    ${options.actions ?? ''}
  </div>`;
}

export function CardContent(body: Renderable, options: { flush?: boolean } = {}) {
  return html`<div class="${options.flush ? 'card-content flush' : 'card-content'}">${body}</div>`;
}

export function Alert(
  body: Renderable,
  options: { variant?: 'default' | 'destructive' | 'success' | 'warning'; title?: Renderable } = {},
) {
  const variant = options.variant ?? 'default';
  return html`<div
    class="${classes('alert', variant !== 'default' && `alert-${variant}`)}"
    ${variant === 'destructive' ? raw('role="alert"') : ''}
  >
    <div>
      ${options.title ? html`<div class="alert-title">${options.title}</div>` : ''}
      <div class="alert-description">${body}</div>
    </div>
  </div>`;
}

type AvatarUser = Pick<User, 'id' | 'username' | 'email' | 'avatarKind' | 'avatarUrl'>;

/**
 * shadcn's Avatar, without a fallback branch — because there is no fallback
 * case. `avatarUrlFor` always returns something, generating an identicon when a
 * user has no picture of their own, so an avatar is never a blank grey circle.
 */
export function Avatar(user: AvatarUser, size: 'sm' | 'default' | 'lg' | 'xl' = 'default') {
  const px = size === 'sm' ? 24 : size === 'lg' ? 56 : size === 'xl' ? 80 : 40;
  return html`<span class="${classes('avatar', size !== 'default' && `avatar-${size}`)}"
    ><img
      src="${avatarUrlFor(user, px * 2)}"
      alt=""
      width="${px}"
      height="${px}"
      loading="lazy"
      decoding="async"
  /></span>`;
}

/**
 * Rendered server-side as words, with the exact instant in `title` and a
 * machine-readable `datetime`. Nothing here needs JavaScript, so a timestamp is
 * correct in a terminal browser and in a feed reader too.
 */
export function TimeAgo(at: number | null | undefined, prefix?: string) {
  if (!at) return html`<span class="muted">never</span>`;
  const iso = new Date(at).toISOString();
  return html`<time datetime="${iso}" title="${iso}">${prefix ? `${prefix} ` : ''}${relativeTime(at)}</time>`;
}

export function Empty(title: string, detail?: Renderable) {
  return html`<div class="empty">
    <div class="empty-title">${title}</div>
    ${detail ? html`<div class="small">${detail}</div>` : ''}
  </div>`;
}

export interface Crumb {
  label: string;
  href?: string;
}

export function Breadcrumb(items: Crumb[]) {
  return html`<nav class="breadcrumb" aria-label="Breadcrumb">
    ${items.map((item, index) =>
      html`${index > 0 ? html`<span class="breadcrumb-separator" aria-hidden="true">/</span>` : ''}${
        item.href && index < items.length - 1
          ? html`<a href="${item.href}">${item.label}</a>`
          : html`<span class="breadcrumb-page" aria-current="page">${item.label}</span>`
      }`,
    )}
  </nav>`;
}

/**
 * Always shows the first and last page plus a window around the current one,
 * with an ellipsis for the gap — so a 400-page forum emits a dozen links rather
 * than 400, and either end is always one click away.
 */
export function Pagination(page: number, pages: number, href: (page: number) => string) {
  if (pages <= 1) return '';
  const span = 2;
  const items: (number | 'gap')[] = [];
  for (let i = 1; i <= pages; i += 1) {
    if (i === 1 || i === pages || (i >= page - span && i <= page + span)) items.push(i);
    else if (items[items.length - 1] !== 'gap') items.push('gap');
  }
  return html`<nav class="pagination" aria-label="Pagination">
    ${page > 1 ? html`<a class="pagination-item" href="${href(page - 1)}" rel="prev">Previous</a>` : ''}
    ${items.map((n) =>
      n === 'gap'
        ? html`<span class="pagination-ellipsis">…</span>`
        : html`<a
            class="pagination-item"
            href="${href(n)}"
            ${n === page ? raw('aria-current="page"') : ''}
            >${n}</a
          >`,
    )}
    ${page < pages ? html`<a class="pagination-item" href="${href(page + 1)}" rel="next">Next</a>` : ''}
  </nav>`;
}

export function Stat(value: number, label: string) {
  return html`<div class="topic-count"><strong>${formatCount(value)}</strong><span>${label}</span></div>`;
}

/** For the handful of places an attribute is assembled by hand inside raw(). */
export function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
