import { html, raw } from 'hono/html';
import type { NavItem, User, Viewer } from '@tsbb/plugin-api';
import { Avatar, LinkButton, trusted, type Renderable } from './primitives.ts';
import { IconBell, IconMoon, IconSun } from './icons.ts';

export interface LayoutSlots {
  head?: string;
  header?: string;
  bodyStart?: string;
  bodyEnd?: string;
  footer?: string;
}

export type ThemeChoice = 'light' | 'dark' | 'system';

export interface LayoutProps {
  title: string;
  description?: string;
  boardName: string;
  viewer: Viewer;
  nav: NavItem[];
  unread?: number;
  stylesheetUrl: string;
  canonical?: string;
  feedUrl?: string;
  slots?: LayoutSlots;
  theme?: ThemeChoice;
  body: Renderable;
}

/**
 * The page shell.
 *
 * Deliberately free of client-side JavaScript. Everything a forum does —
 * reading, posting, moderating, paging, searching, even switching theme — is a
 * document request or a form submission, so the board works with scripting off,
 * on a slow connection, and in a terminal browser.
 *
 * The theme in particular is a cookie the server reads, not a localStorage
 * value a script applies after load. That removes the usual pre-paint inline
 * script along with the flash it exists to prevent: `data-theme` is already in
 * the markup when the document arrives. Leaving the attribute off entirely is
 * the third, real state — follow the system — which the CSS answers through
 * prefers-color-scheme.
 */
export function Layout(props: LayoutProps) {
  const slots = props.slots ?? {};
  const theme = props.theme ?? 'system';
  const title =
    props.title === props.boardName ? props.boardName : `${props.title} · ${props.boardName}`;

  return html`<!doctype html>
<html lang="en"${theme === 'system' ? '' : raw(` data-theme="${theme}"`)}>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    ${props.description ? html`<meta name="description" content="${props.description}" />` : ''}
    ${props.canonical ? html`<link rel="canonical" href="${props.canonical}" />` : ''}
    ${props.feedUrl
      ? html`<link rel="alternate" type="application/rss+xml" title="${props.boardName}" href="${props.feedUrl}" />`
      : ''}
    <meta property="og:type" content="website" />
    <meta property="og:title" content="${props.title}" />
    <meta property="og:site_name" content="${props.boardName}" />
    ${props.description ? html`<meta property="og:description" content="${props.description}" />` : ''}
    ${props.canonical ? html`<meta property="og:url" content="${props.canonical}" />` : ''}
    <meta name="twitter:card" content="summary" />
    <link rel="stylesheet" href="${props.stylesheetUrl}" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="icon" href="/icons/icon-32.png" sizes="32x32" type="image/png" />
    <link rel="icon" href="/icons/icon-16.png" sizes="16x16" type="image/png" />
    <link rel="apple-touch-icon" href="/icons/icon-180.png" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-title" content="${props.boardName}" />
    <!--
      Two theme-colors so the browser chrome follows the reader's theme. A
      single one paints a light bar above a dark page on every mobile browser.
    -->
    <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#09090b" media="(prefers-color-scheme: dark)" />
    <!--
      The only script the board serves, and it is pure enhancement: it registers
      a service worker for offline reading and installability. Every page is
      complete without it, which is why it can be deferred and why the CSP still
      forbids inline script entirely.
    -->
    <script src="/register-sw.js" defer></script>
    ${trusted(slots.head)}
  </head>
  <body>
    <a class="skip-link" href="#main">Skip to content</a>
    ${trusted(slots.bodyStart)}
    <div class="shell">
      <header class="site-header">
        <div class="container site-header-inner">
          <a class="brand" href="/">
            <span class="brand-mark" aria-hidden="true">${props.boardName.slice(0, 1).toUpperCase()}</span>
            <span>${props.boardName}</span>
          </a>
          <nav class="site-nav" aria-label="Main">
            ${props.nav.map(
              (item) =>
                html`<a class="${item.match === 'active' ? 'nav-link active' : 'nav-link'}" href="${item.href}"
                  >${item.label}</a
                >`,
            )}
          </nav>
          <div class="header-actions">
            <form class="search-form" action="/search" method="get" role="search">
              <input class="input" type="search" name="q" placeholder="Search…" aria-label="Search the board" />
            </form>
            ${ThemeToggle(theme)}
            ${props.viewer.user
              ? html`${NotificationBell(props.unread ?? 0)}${UserMenu(props.viewer.user, props.viewer.isAdmin)}`
              : LinkButton('Sign in', '/login', { size: 'sm' })}
          </div>
        </div>
        ${trusted(slots.header)}
      </header>
      <main class="main" id="main"><div class="container">${props.body}</div></main>
      <footer class="site-footer">
        <div class="container row-between">
          <span
            >${props.boardName} — running on
            <a href="https://github.com/profullstack/tsbb" rel="noopener">tsbb</a></span
          >
          <span class="row">
            <a href="/members">Members</a>
            <a href="/feed.xml">RSS</a>
            ${props.viewer.isAdmin ? html`<a href="/admin">Admin</a>` : ''}
          </span>
        </div>
        ${trusted(slots.footer)}
      </footer>
    </div>
    ${trusted(slots.bodyEnd)}
  </body>
</html>`;
}

function NotificationBell(unread: number) {
  const label = unread ? `Notifications, ${unread} unread` : 'Notifications';
  return html`<a class="btn btn-ghost btn-icon notif-button" href="/notifications" aria-label="${label}"
    >${IconBell()}${unread ? html`<span class="notif-dot">${unread > 99 ? '99+' : unread}</span>` : ''}</a
  >`;
}

/**
 * Cycles light -> dark -> system. The server already knows which theme is
 * active, so it renders the icon for what pressing the button will do and the
 * control is correct without a line of script.
 */
function ThemeToggle(theme: ThemeChoice) {
  const next = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light';
  const label =
    next === 'dark'
      ? 'Switch to dark theme'
      : next === 'light'
        ? 'Switch to light theme'
        : 'Follow the system theme';
  return html`<form action="/prefs/theme" method="post">
    <input type="hidden" name="theme" value="${next}" />
    <button class="btn btn-ghost btn-icon" type="submit" aria-label="${label}" title="${label}">
      ${theme === 'dark' ? IconSun() : IconMoon()}
    </button>
  </form>`;
}

function UserMenu(user: User, isAdmin: boolean) {
  return html`<details class="dropdown">
    <summary aria-label="Account menu">${Avatar(user, 'sm')}</summary>
    <div class="dropdown-content">
      <div class="dropdown-label">${user.displayName ?? user.username}</div>
      <a class="dropdown-item" href="/u/${user.username}">Profile</a>
      <a class="dropdown-item" href="/messages">Messages</a>
      <a class="dropdown-item" href="/settings">Settings</a>
      ${isAdmin
        ? html`<div class="dropdown-separator"></div>
            <a class="dropdown-item" href="/admin">Administration</a>`
        : ''}
      <div class="dropdown-separator"></div>
      <form action="/logout" method="post">
        <button class="dropdown-item destructive" type="submit">Sign out</button>
      </form>
    </div>
  </details>`;
}
