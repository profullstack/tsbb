import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { NavItem, Viewer } from '@tsbb/plugin-api';
import type { Registry } from '@tsbb/plugin-host';
import { guestViewer, loadSettings, unreadCount, viewerFromSession, type Settings } from '@tsbb/core';
import {
  Layout,
  isSkin,
  stylesheetUrl,
  SKIN_THEME_COLOR,
  type Brand,
  type LayoutSlots,
  type Skin,
  type ThemeChoice,
} from '@tsbb/ui';

/** The board's chosen skin, defaulting to modern for an unset or bad value. */
export function skinOf(settings: Record<string, unknown>): Skin {
  const value = settings['board.skin'];
  return isSkin(value) ? value : 'modern';
}

/** The board's accent, if one is configured. */
export function brandOf(settings: Record<string, unknown>): Brand {
  const accent = settings['board.accent'];
  return { accent: typeof accent === 'string' && accent.trim() ? accent.trim() : null };
}

/** A configured URL, or undefined for the empty string every setting defaults to. */
function urlSetting(settings: Record<string, unknown>, key: string): string | undefined {
  const value = settings[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export const SESSION_COOKIE = 'tsbb_session';
export const THEME_COOKIE = 'tsbb_theme';

export interface AppEnv {
  Variables: {
    viewer: Viewer;
    settings: Settings;
    theme: ThemeChoice;
  };
}

export interface Services {
  registry: Registry;
  baseUrl: string;
}

export async function resolveViewer(c: Context): Promise<Viewer> {
  const sessionId = getCookie(c, SESSION_COOKIE);
  const viewer = await viewerFromSession(sessionId);
  if (viewer.user) return viewer;
  return guestViewer();
}

/**
 * The reader's theme.
 *
 * A cookie is the reader's own choice and always wins. With no cookie the
 * board's `board.theme` setting decides, and only if that is 'system' (the
 * default) does the page ship without a data-theme attribute and follow the
 * operating system. That ordering is what lets a board be dark by default
 * without taking the choice away from anyone who has made one.
 */
export function readTheme(c: Context, settings?: Record<string, unknown>): ThemeChoice {
  const value = getCookie(c, THEME_COOKIE);
  if (value === 'light' || value === 'dark' || value === 'system') return value;
  const preferred = settings?.['board.theme'];
  return preferred === 'light' || preferred === 'dark' ? preferred : 'system';
}

function navFor(viewer: Viewer, path: string): NavItem[] {
  const items: NavItem[] = [
    { label: 'Forums', href: '/', weight: 0, match: path === '/' ? 'active' : undefined },
    { label: 'Latest', href: '/latest', weight: 10, match: path.startsWith('/latest') ? 'active' : undefined },
    { label: 'Members', href: '/members', weight: 20, match: path.startsWith('/members') ? 'active' : undefined },
  ];
  if (viewer.isModerator) {
    items.push({
      label: 'Moderation',
      href: '/moderation',
      weight: 30,
      match: path.startsWith('/moderation') ? 'active' : undefined,
      requires: 'moderator',
    });
  }
  return items;
}

export interface RenderOptions {
  title: string;
  description?: string;
  canonical?: string;
  feedUrl?: string;
  /**
   * The response status. It has to travel with the render rather than being
   * set beforehand, because c.html() writes 200 over whatever c.status() said —
   * which is how an error page ends up being served as a successful one.
   */
  status?: 200 | 400 | 403 | 404 | 410 | 500;
  body: unknown;
}

/**
 * Render a full page.
 *
 * The five layout slots are rendered concurrently — no plugin can see another's
 * output, so there is nothing to serialise — and the bus orders the results by
 * weight afterwards, which keeps the page stable however the network behaved.
 */
export async function render(
  c: Context<AppEnv>,
  services: Services,
  options: RenderOptions,
): Promise<Response> {
  /*
   * The viewer and settings are normally put in place by the middleware, but
   * render() is also reached from the 404 and error handlers — and those can
   * fire on a route registered before the middleware, or when the middleware
   * itself is what threw. So both are resolved defensively here. An error page
   * that throws while rendering is the one failure with no floor under it.
   */
  const viewer = c.get('viewer') ?? (await resolveViewer(c));
  const settings = c.get('settings') ?? (await loadSettings());
  const url = new URL(c.req.url);
  const renderContext = { viewer, url, settings: settings as Record<string, unknown> };
  const bus = services.registry.bus;

  const [head, header, bodyStart, bodyEnd, footer, unread] = await Promise.all([
    bus.renderSlot('layout:head', renderContext),
    bus.renderSlot('layout:header', renderContext),
    bus.renderSlot('layout:body_start', renderContext),
    bus.renderSlot('layout:body_end', renderContext),
    bus.renderSlot('layout:footer', renderContext),
    viewer.user ? unreadCount(viewer.user.id) : Promise.resolve(0),
  ]);

  const slots: LayoutSlots = { head, header, bodyStart, bodyEnd, footer };
  const nav = await bus.applyFilter('nav:items', navFor(viewer, url.pathname), renderContext);

  const skin = skinOf(settings as Record<string, unknown>);
  const markup = await Layout({
    title: options.title,
    description: options.description,
    boardName: String(settings['board.name'] ?? 'tsbb'),
    viewer,
    nav,
    unread,
    stylesheetUrl: stylesheetUrl(skin, brandOf(settings as Record<string, unknown>)),
    logoUrl: urlSetting(settings as Record<string, unknown>, 'board.logoUrl'),
    faviconUrl: urlSetting(settings as Record<string, unknown>, 'board.faviconUrl'),
    themeColor: SKIN_THEME_COLOR[skin],
    canonical: options.canonical ?? new URL(url.pathname, services.baseUrl).toString(),
    feedUrl: options.feedUrl,
    slots,
    theme: c.get('theme') ?? readTheme(c, settings as Record<string, unknown>),
    body: options.body as never,
  });

  return c.html(String(markup), options.status ?? 200);
}

/** Render a plugin slot in a page body. Returns '' when nothing is registered. */
export async function slot(
  c: Context<AppEnv>,
  services: Services,
  name: Parameters<Registry['bus']['renderSlot']>[0],
  extra: Record<string, unknown> = {},
): Promise<string> {
  const url = new URL(c.req.url);
  return services.registry.bus.renderSlot(name, {
    viewer: c.get('viewer'),
    url,
    settings: c.get('settings') as Record<string, unknown>,
    ...extra,
  } as never);
}
