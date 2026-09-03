import { Hono } from 'hono';
import type { Context } from 'hono';
import { html, raw } from 'hono/html';
import { all, now, one, run } from '@tsbb/db';
import {
  allForums,
  createFeedSource,
  createForum,
  DEFAULT_SETTINGS,
  deleteFeedSource,
  feedSourceById,
  feedSourceCounts,
  FeedSourceError,
  fetchFeedSource,
  forumById,
  isMemberPosting,
  listFeedSources,
  loadSettings,
  MEMBER_POSTING,
  recountForum,
  setSettings,
  toInt,
  toBool,
  updateFeedSource,
  updateForum,
  updateState,
  userByUsername,
} from '@tsbb/core';
import { escapeHtml } from '@tsbb/markup';
import type { SettingSpec } from '@tsbb/plugin-api';
import {
  Alert,
  Badge,
  trusted,
  Button,
  Card,
  CardContent,
  CardHeader,
  Empty,
  LinkButton,
  SKINS,
  TimeAgo,
} from '@tsbb/ui';
import { render, slot, type AppEnv, type Services } from '../context.ts';
import { runUpdateCycle, updatesEnabled } from '../updates.ts';

const NAV = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/settings', label: 'Board settings' },
  { href: '/admin/forums', label: 'Forums' },
  { href: '/admin/plugins', label: 'Plugins' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/moderation', label: 'Moderation' },
];

export function adminRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  /**
   * One gate for the whole area, rather than a check in each handler.
   *
   * It also refuses a request carrying an API token even if that token's owner
   * is an administrator: administrative power needs a real session, so a leaked
   * token can never reconfigure the board.
   */
  app.use('/admin/*', async (c, next) => {
    const viewer = c.get('viewer');
    if (!viewer.user) return c.redirect(`/login?redirect=${encodeURIComponent(c.req.path)}`, 302);
    if (viewer.viaToken || !viewer.isAdmin) {
      return render(c, services, {
        title: 'Not allowed',
        status: 403,
        body: Card(
          CardContent(
            Empty(
              'Not allowed',
              viewer.viaToken
                ? 'Administration needs a browser session. A token is never an administrator.'
                : 'You are not an administrator of this board.',
            ),
          ),
        ),
      });
    }
    await next();
  });
  app.use('/admin', async (c, next) => {
    const viewer = c.get('viewer');
    if (!viewer.user) return c.redirect('/login?redirect=%2Fadmin', 302);
    if (viewer.viaToken || !viewer.isAdmin) return c.text('Not allowed', 403);
    await next();
  });

  const page = async (c: Context<AppEnv>, title: string, body: unknown) => {
    // Plugins can add their own entries to the administration menu.
    const adminNav = await slot(c, services, 'admin:nav');
    return render(c, services, {
      title: `${title} · Administration`,
      body: html`<div class="admin-layout">
        <nav class="admin-nav">
          <div class="admin-nav-heading">Administration</div>
          ${NAV.map(
            (item) =>
              html`<a
                class="${c.req.path === item.href ? 'dropdown-item' : 'dropdown-item'}"
                href="${item.href}"
                style="${c.req.path === item.href ? 'background:var(--accent);font-weight:600' : ''}"
                >${item.label}</a
              >`,
          )}
          ${trusted(adminNav)}
          <div class="admin-nav-heading">Board</div>
          <a class="dropdown-item" href="/">Back to the forums</a>
        </nav>
        <div>${body}</div>
      </div>`,
    });
  };

  // --- Overview -----------------------------------------------------------

  app.get('/admin', async (c) => {
    const stats = await one<{ users: number; topics: number; posts: number; reports: number }>(
      `SELECT
         (SELECT COUNT(*) FROM users WHERE is_deleted = 0) AS users,
         (SELECT COUNT(*) FROM topics WHERE is_deleted = 0) AS topics,
         (SELECT COUNT(*) FROM posts WHERE is_deleted = 0) AS posts,
         (SELECT COUNT(*) FROM reports WHERE status = 'open') AS reports`,
    );
    const mail = await all<{ status: string; n: number }>(
      'SELECT status, COUNT(*) AS n FROM email_queue GROUP BY status',
    );
    const registry = services.registry;
    const updates = await updateState();
    const updateNotice = c.req.query('updates');

    return page(
      c,
      'Overview',
      html`
        <div class="page-head"><h1 class="page-title">Overview</h1></div>
        ${updateNotice === 'restarting'
          ? Alert('The new version is installed and the board is restarting. Give it a few seconds, then reload.', {
              variant: 'warning',
              title: 'Updating',
            })
          : ''}
        ${Number(stats?.reports ?? 0) > 0
          ? Alert(html`<a href="/admin/moderation">${stats?.reports} reports are waiting.</a>`, {
              variant: 'warning',
              title: 'Moderation queue',
            })
          : ''}
        <div class="stack">
          ${Card(html`${CardHeader('The board')}
            ${CardContent(html`<div class="profile-stats">
              <div class="profile-stat"><strong>${stats?.users ?? 0}</strong><span>members</span></div>
              <div class="profile-stat"><strong>${stats?.topics ?? 0}</strong><span>topics</span></div>
              <div class="profile-stat"><strong>${stats?.posts ?? 0}</strong><span>posts</span></div>
            </div>`)}`)}
          ${updatesCard(updates)}
          ${Card(html`${CardHeader('Mail queue', { description: 'The worker drains this every 15 seconds.' })}
            ${CardContent(
              mail.length
                ? html`<div class="row">${mail.map((row) => Badge(`${row.status}: ${row.n}`, 'secondary'))}</div>`
                : html`<p class="small muted">Nothing queued.</p>`,
            )}`)}
          ${Card(html`${CardHeader('Plugins', { actions: LinkButton('Manage', '/admin/plugins', { variant: 'outline', size: 'sm' }) })}
            ${CardContent(html`<div class="row">
              ${[...registry.plugins.keys()].map((slug) =>
                Badge(slug, registry.enabled.has(slug) ? 'success' : 'outline'),
              )}
            </div>
            ${registry.errors.size
              ? html`<div style="margin-top:.75rem">${Alert(
                  html`${[...registry.errors.entries()].map(([slug, error]) => html`<div><strong>${slug}</strong>: ${error}</div>`)}`,
                  { variant: 'destructive', title: 'Plugin problems' },
                )}</div>`
              : ''}`)}`)}
        </div>
      `,
    );
  });

  // --- Updates ------------------------------------------------------------
  // "Check now" only asks; "Update now" installs and restarts. Both come back
  // to the overview, which reads what the cycle recorded in settings, so a
  // failure is shown where the button was rather than lost in a log.

  app.post('/admin/updates/check', async (c) => {
    if (!updatesEnabled()) return c.redirect('/admin', 303);
    await runUpdateCycle({ apply: false }).catch(() => {});
    return c.redirect('/admin', 303);
  });

  app.post('/admin/updates/apply', async (c) => {
    if (!updatesEnabled()) return c.redirect('/admin', 303);
    const outcome = await runUpdateCycle({ apply: true }).catch(() => 'failed');
    return c.redirect(outcome.startsWith('updated') ? '/admin?updates=restarting' : '/admin', 303);
  });

  // --- Board settings -----------------------------------------------------

  const SETTING_GROUPS: { title: string; keys: string[] }[] = [
    { title: 'Identity', keys: ['board.name', 'board.tagline', 'board.description'] },
    {
      title: 'Appearance',
      keys: [
        'board.skin',
        'board.theme',
        'board.accent',
        'board.logoUrl',
        'board.logoHref',
        'board.faviconUrl',
      ],
    },
    { title: 'Registration', keys: ['registration.mode', 'registration.minUsernameLength', 'registration.maxUsernameLength'] },
    { title: 'Posting', keys: ['posts.defaultFormat', 'posts.perPage', 'posts.minLength', 'posts.maxLength', 'posts.editWindowMinutes', 'posts.floodSeconds', 'topics.perPage', 'topics.titleMaxLength'] },
    { title: 'Signatures', keys: ['signatures.enabled', 'signatures.minPosts', 'signatures.maxLength'] },
    { title: 'Avatars', keys: ['avatars.enabled', 'avatars.allowUpload', 'avatars.allowGravatar', 'avatars.maxBytes'] },
    { title: 'Notifications', keys: ['notifications.emailEnabled', 'notifications.mentionsEnabled'] },
    {
      title: 'Feeds and search',
      keys: ['feeds.enabled', 'feeds.itemLimit', 'feeds.importEnabled', 'search.enabled', 'search.minLength'],
    },
    { title: 'Updates', keys: ['updates.auto'] },
  ];

  const HELP: Record<string, string> = {
    'board.skin':
      'modern is cards and generous spacing. classic is a 2000s bulletin board: boxy, dense, gradient title bars. terminal is neutral surfaces, hairline rules and monospace chrome. Same board either way — only the stylesheet changes.',
    'board.theme':
      'What a reader who has never touched the theme toggle sees. system follows their operating system. Anyone who does use the toggle keeps their own choice either way.',
    'board.accent':
      'One hex colour, like #5fff87. Links, buttons and highlights follow it, and it is darkened for the light theme and brightened for the dark one so it stays legible in both. Empty means the built-in palette.',
    'board.logoUrl':
      'A URL to your own artwork. It replaces the generated letter mark and the board name in the header, so use a wordmark rather than a bare icon.',
    'board.logoHref':
      'Where the header logo points. / is this board. An absolute URL is for a board that is one room in a larger site — the nav still leads back to the front page, so nobody is stranded.',
    'board.faviconUrl': 'A URL to a browser-tab icon. Replaces the bundled tsbb icons.',
    'signatures.minPosts':
      'How many posts before a signature is shown. A new account with a link-filled signature is the shape of every piece of forum spam, so this is 10 by default.',
    'posts.floodSeconds': 'Seconds between posts by the same account. 0 turns flood control off.',
    'posts.editWindowMinutes': 'How long an author may edit their own post. 0 means forever.',
    'feeds.importEnabled':
      'Whether the worker fetches the RSS and Atom feeds that fill forums. Which feeds fill which forum is set on each forum under Forums.',
    'updates.auto':
      'When a new release is published the board fetches it, installs it and restarts itself, within five minutes. Off means the overview still says a new version exists, and you install it. A board running from a container is never updated this way: redeploy the image.',
  };

  app.get('/admin/settings', async (c) => {
    const settings = await loadSettings(true);
    return page(
      c,
      'Board settings',
      html`
        <div class="page-head"><h1 class="page-title">Board settings</h1></div>
        <form method="post" action="/admin/settings" class="stack">
          ${SETTING_GROUPS.map((group) =>
            Card(html`${CardHeader(group.title)}
              ${CardContent(html`${group.keys.map((key) => settingField(key, settings[key], HELP[key]))}`)}`),
          )}
          <div>${Button('Save settings', { type: 'submit' })}</div>
        </form>
      `,
    );
  });

  app.post('/admin/settings', async (c) => {
    const form = await c.req.parseBody();
    const patch: Record<string, unknown> = {};
    for (const group of SETTING_GROUPS) {
      for (const key of group.keys) {
        const current = (DEFAULT_SETTINGS as Record<string, unknown>)[key];
        // The type of the default decides how the submitted value is read. An
        // unchecked checkbox sends nothing at all, which is why booleans are
        // handled by presence rather than by value.
        if (typeof current === 'boolean') patch[key] = toBool(form[key]);
        else if (typeof current === 'number') patch[key] = toInt(form[key], Number(current));
        else patch[key] = String(form[key] ?? current ?? '');
      }
    }
    await setSettings(patch);
    return c.redirect('/admin/settings', 303);
  });

  // --- Forums -------------------------------------------------------------

  app.get('/admin/forums', async (c) => {
    const forums = await allForums();
    const feedCounts = await feedSourceCounts();
    const byParent = new Map<number | null, typeof forums>();
    for (const forum of forums) {
      const list = byParent.get(forum.parentId) ?? [];
      list.push(forum);
      byParent.set(forum.parentId, list);
    }

    const rows = (parentId: number | null, depth: number): unknown[] =>
      (byParent.get(parentId) ?? []).flatMap((forum) => [
        html`<tr>
          <td>
            <span style="padding-left:${depth * 1.25}rem">
              ${forum.kind === 'category' ? Badge('Category', 'secondary') : ''}
              <a href="/f/${forum.slug}">${forum.name}</a>
              ${feedBadge(feedCounts.get(forum.id) ?? 0)}
              ${forum.memberPosting !== 'topics' ? Badge(MEMBER_POSTING_LABEL[forum.memberPosting], 'outline') : ''}
            </span>
          </td>
          <td class="tiny muted">${forum.slug}</td>
          <td>${forum.topicCount}</td>
          <td>${forum.postCount}</td>
          <td>
            <div class="row">
              ${LinkButton('Edit', `/admin/forums/${forum.id}`, { variant: 'ghost', size: 'sm' })}
              <form method="post" action="/admin/forums/${forum.id}/delete"
                onsubmit="return confirm('Delete ${escapeHtml(forum.name)} and everything in it?')">
                ${Button('Delete', { type: 'submit', variant: 'ghost', size: 'sm' })}
              </form>
            </div>
          </td>
        </tr>`,
        ...rows(forum.id, depth + 1),
      ]);

    const parents = forums.filter((f) => f.kind === 'category');

    return page(
      c,
      'Forums',
      html`
        <div class="page-head"><h1 class="page-title">Forums</h1></div>
        <div class="stack">
          ${Card(
            CardContent(
              forums.length
                ? html`<div class="table-wrap"><table class="table">
                    <thead><tr><th>Name</th><th>Slug</th><th>Topics</th><th>Posts</th><th></th></tr></thead>
                    <tbody>${rows(null, 0)}</tbody>
                  </table></div>`
                : Empty('No forums yet', 'Add a category, then a forum inside it.'),
              { flush: true },
            ),
          )}
          ${Card(html`${CardHeader('Add a forum')}
            ${CardContent(html`<form method="post" action="/admin/forums">
              <div class="field">
                <label class="label" for="name">Name</label>
                <input class="input" id="name" name="name" required />
              </div>
              <div class="field">
                <label class="label" for="description">Description</label>
                <input class="input" id="description" name="description" />
              </div>
              <div class="row">
                <div class="field grow">
                  <label class="label" for="kind">Kind</label>
                  <select class="select" id="kind" name="kind">
                    <option value="forum">Forum — holds topics</option>
                    <option value="category">Category — holds forums</option>
                  </select>
                </div>
                <div class="field grow">
                  <label class="label" for="parentId">Inside</label>
                  <select class="select" id="parentId" name="parentId">
                    <option value="">Top level</option>
                    ${parents.map((p) => html`<option value="${p.id}">${p.name}</option>`)}
                  </select>
                </div>
                <div class="field">
                  <label class="label" for="position">Order</label>
                  <input class="input" id="position" name="position" type="number" value="0" style="width:6rem" />
                </div>
              </div>
              ${memberPostingField('topics')}
              ${Button('Add', { type: 'submit' })}
            </form>`)}`)}
        </div>
      `,
    );
  });

  app.post('/admin/forums', async (c) => {
    const form = await c.req.parseBody();
    await createForum({
      name: String(form.name ?? '').trim().slice(0, 80),
      description: String(form.description ?? '').trim() || undefined,
      kind: form.kind === 'category' ? 'category' : 'forum',
      parentId: form.parentId ? Number(form.parentId) : null,
      position: toInt(form.position, 0),
      memberPosting: isMemberPosting(form.memberPosting) ? form.memberPosting : 'topics',
    });
    return c.redirect('/admin/forums', 303);
  });

  // --- One forum: its settings and the feeds that fill it ------------------

  app.get('/admin/forums/:id', async (c) => {
    const forum = await forumById(Number(c.req.param('id')));
    if (!forum) return c.notFound();
    const sources = forum.kind === 'forum' ? await listFeedSources(forum.id) : [];
    const viewer = c.get('viewer');
    const notice = c.req.query('notice');
    const problem = c.req.query('error');

    return page(
      c,
      forum.name,
      html`
        <div class="page-head">
          <div>
            <h1 class="page-title">${forum.name}</h1>
            <p class="page-subtitle"><a href="/f/${forum.slug}">/f/${forum.slug}</a></p>
          </div>
          ${LinkButton('All forums', '/admin/forums', { variant: 'ghost', size: 'sm' })}
        </div>
        ${problem ? Alert(problem, { variant: 'destructive', title: 'That did not work' }) : ''}
        ${notice ? Alert(notice, { variant: 'success' }) : ''}
        <div class="stack">
          ${Card(html`${CardHeader('Settings')}
            ${CardContent(html`<form method="post" action="/admin/forums/${forum.id}" class="stack">
              <div class="field">
                <label class="label" for="name">Name</label>
                <input class="input" id="name" name="name" required value="${forum.name}" />
              </div>
              <div class="field">
                <label class="label" for="description">Description</label>
                <input class="input" id="description" name="description" value="${forum.description ?? ''}" />
              </div>
              <div class="row">
                <div class="field">
                  <label class="label" for="position">Order</label>
                  <input class="input" id="position" name="position" type="number" value="${forum.position}" style="width:6rem" />
                </div>
                <div class="checkbox-row">
                  <input type="checkbox" id="isLocked" name="isLocked" ${forum.isLocked ? 'checked' : ''} />
                  <div><label for="isLocked">Locked</label><div class="field-hint">Nothing new is posted here, by anyone or any feed.</div></div>
                </div>
                <div class="checkbox-row">
                  <input type="checkbox" id="isHidden" name="isHidden" ${forum.isHidden ? 'checked' : ''} />
                  <div><label for="isHidden">Hidden</label><div class="field-hint">Only staff see it.</div></div>
                </div>
              </div>
              ${forum.kind === 'forum' ? memberPostingField(forum.memberPosting) : ''}
              <div>${Button('Save', { type: 'submit' })}</div>
            </form>`)}`)}
          ${forum.kind === 'forum'
            ? html`${Card(html`${CardHeader('Feeds that fill this forum', {
                  description:
                    'Each new item in the feed becomes a topic, posted by the account you choose. Members reply according to the posting rule above.',
                })}
                ${CardContent(
                  sources.length
                    ? html`<div class="table-wrap"><table class="table">
                        <thead><tr><th>Feed</th><th>Posts as</th><th>Every</th><th>Last fetch</th><th>Topics</th><th></th></tr></thead>
                        <tbody>${sources.map(
                          (source) => html`<tr>
                            <td>
                              <div>${source.title ?? source.url}</div>
                              <div class="tiny muted">${source.url}</div>
                              ${source.isEnabled ? '' : html`<div>${Badge('Paused', 'secondary')}</div>`}
                            </td>
                            <td>${source.postAs ? html`<a href="/u/${source.postAs}">${source.postAs}</a>` : Badge('Account gone', 'destructive')}</td>
                            <td class="small">${source.intervalMinutes} min, up to ${source.maxItems}</td>
                            <td class="small">
                              ${source.lastStatus === 'error'
                                ? html`${Badge('Error', 'destructive')} <span class="tiny muted">${source.lastError ?? ''}</span>`
                                : source.lastStatus
                                  ? html`${Badge(source.lastStatus === 'ok' ? 'OK' : 'Unchanged', 'outline')} ${TimeAgo(source.fetchedAt)}`
                                  : html`<span class="muted">Not yet</span>`}
                            </td>
                            <td>${source.itemCount}</td>
                            <td>
                              <div class="row">
                                <form method="post" action="/admin/forums/${forum.id}/feeds/${source.id}/fetch">
                                  ${Button('Fetch now', { type: 'submit', variant: 'ghost', size: 'sm' })}
                                </form>
                                <form method="post" action="/admin/forums/${forum.id}/feeds/${source.id}/toggle">
                                  ${Button(source.isEnabled ? 'Pause' : 'Resume', { type: 'submit', variant: 'ghost', size: 'sm' })}
                                </form>
                                <form method="post" action="/admin/forums/${forum.id}/feeds/${source.id}/delete"
                                  onsubmit="return confirm('Remove this feed? The topics it posted stay.')">
                                  ${Button('Remove', { type: 'submit', variant: 'ghost', size: 'sm' })}
                                </form>
                              </div>
                            </td>
                          </tr>`,
                        )}</tbody>
                      </table></div>`
                    : Empty('No feeds yet', 'Add an RSS or Atom feed below and its items become topics here.'),
                  { flush: true },
                )}`)}
              ${Card(html`${CardHeader('Add a feed')}
                ${CardContent(html`<form method="post" action="/admin/forums/${forum.id}/feeds">
                  <div class="field">
                    <label class="label" for="url">Feed URL</label>
                    <input class="input" id="url" name="url" type="url" required placeholder="https://example.com/feed.xml" />
                  </div>
                  <div class="row">
                    <div class="field grow">
                      <label class="label" for="postAs">Post as</label>
                      <input class="input" id="postAs" name="postAs" value="${viewer.user?.username ?? ''}" required />
                      <div class="field-hint">A member's username. Topics appear under this account.</div>
                    </div>
                    <div class="field">
                      <label class="label" for="intervalMinutes">Every (minutes)</label>
                      <input class="input" id="intervalMinutes" name="intervalMinutes" type="number" value="30" min="5" style="width:8rem" />
                    </div>
                    <div class="field">
                      <label class="label" for="maxItems">Items per fetch</label>
                      <input class="input" id="maxItems" name="maxItems" type="number" value="10" min="1" max="100" style="width:8rem" />
                      <div class="field-hint">The first fetch posts only this many; older items are skipped, not queued.</div>
                    </div>
                  </div>
                  ${Button('Add feed', { type: 'submit' })}
                </form>`)}`)}`
            : ''}
        </div>
      `,
    );
  });

  app.post('/admin/forums/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const form = await c.req.parseBody();
    const forum = await updateForum(id, {
      name: String(form.name ?? '').trim().slice(0, 80) || undefined,
      description: String(form.description ?? '').trim() || null,
      position: toInt(form.position, 0),
      isLocked: toBool(form.isLocked),
      isHidden: toBool(form.isHidden),
      memberPosting: isMemberPosting(form.memberPosting) ? form.memberPosting : undefined,
    });
    if (!forum) return c.notFound();
    return c.redirect(`/admin/forums/${id}?notice=${encodeURIComponent('Saved.')}`, 303);
  });

  app.post('/admin/forums/:id/feeds', async (c) => {
    const id = Number(c.req.param('id'));
    const viewer = c.get('viewer');
    const form = await c.req.parseBody();
    const back = (query: string) => c.redirect(`/admin/forums/${id}?${query}`, 303);
    try {
      const postAs = await userByUsername(String(form.postAs ?? '').trim());
      if (!postAs || postAs.isBanned) throw new FeedSourceError('Choose a member in good standing to post as.');
      await createFeedSource({
        forumId: id,
        url: String(form.url ?? ''),
        userId: postAs.id,
        intervalMinutes: toInt(form.intervalMinutes, 30),
        maxItems: toInt(form.maxItems, 10),
        createdBy: viewer.user?.id ?? null,
      });
    } catch (error) {
      if (error instanceof FeedSourceError) return back(`error=${encodeURIComponent(error.message)}`);
      throw error;
    }
    return back(`notice=${encodeURIComponent('Feed added. It is fetched on the worker\'s next tick, or fetch it now.')}`);
  });

  app.post('/admin/forums/:id/feeds/:sourceId/fetch', async (c) => {
    const id = Number(c.req.param('id'));
    const source = await feedSourceById(Number(c.req.param('sourceId')));
    if (!source || source.forumId !== id) return c.notFound();
    const result = await fetchFeedSource(source, { baseUrl: services.baseUrl, bus: services.registry.bus });
    const message =
      result.status === 'error'
        ? `error=${encodeURIComponent(result.error ?? 'The fetch failed.')}`
        : `notice=${encodeURIComponent(
            result.status === 'unchanged'
              ? 'The feed has not changed since last time.'
              : `Fetched. ${result.added} new topic${result.added === 1 ? '' : 's'}.`,
          )}`;
    return c.redirect(`/admin/forums/${id}?${message}`, 303);
  });

  app.post('/admin/forums/:id/feeds/:sourceId/toggle', async (c) => {
    const id = Number(c.req.param('id'));
    const source = await feedSourceById(Number(c.req.param('sourceId')));
    if (!source || source.forumId !== id) return c.notFound();
    await updateFeedSource(source.id, { isEnabled: !source.isEnabled });
    return c.redirect(`/admin/forums/${id}`, 303);
  });

  app.post('/admin/forums/:id/feeds/:sourceId/delete', async (c) => {
    const id = Number(c.req.param('id'));
    const source = await feedSourceById(Number(c.req.param('sourceId')));
    if (!source || source.forumId !== id) return c.notFound();
    await deleteFeedSource(source.id);
    return c.redirect(`/admin/forums/${id}`, 303);
  });

  app.post('/admin/forums/:id/delete', async (c) => {
    const id = Number(c.req.param('id'));
    // ON DELETE CASCADE takes the topics and posts with it; the counters of
    // whatever was above it have to be rebuilt afterwards.
    const forum = await one<{ parent_id: number | null }>('SELECT parent_id FROM forums WHERE id = ?', [id]);
    await run('DELETE FROM forums WHERE id = ?', [id]);
    if (forum?.parent_id) await recountForum(forum.parent_id);
    return c.redirect('/admin/forums', 303);
  });

  // --- Plugins ------------------------------------------------------------

  app.get('/admin/plugins', async (c) => {
    const registry = services.registry;
    const rows = await all<{ slug: string; name: string; version: string; source: string; enabled: number; last_error: string | null }>(
      'SELECT slug, name, version, source, enabled, last_error FROM plugins ORDER BY slug',
    );

    return page(
      c,
      'Plugins',
      html`
        <div class="page-head">
          <div>
            <h1 class="page-title">Plugins</h1>
            <p class="page-subtitle">Drop a directory into <code>plugins/</code> and it appears here.</p>
          </div>
        </div>
        ${Alert(
          'A plugin is code running inside the board, exactly as in phpBB or WordPress. Installing one is installing code — only enable plugins you trust.',
          { variant: 'warning', title: 'What a plugin can do' },
        )}
        <div class="stack" style="margin-top:1rem">
          ${rows.length
            ? rows.map((row) => {
                const discovered = registry.plugins.get(row.slug);
                const manifest = discovered?.manifest;
                const on = registry.enabled.has(row.slug);
                return Card(html`
                  ${CardHeader(row.name, {
                    description: manifest?.description ?? `${row.source} · v${row.version}`,
                    actions: html`<form method="post" action="/admin/plugins/${row.slug}/toggle">
                      <input type="hidden" name="enabled" value="${on ? '0' : '1'}" />
                      ${Button(on ? 'Disable' : 'Enable', {
                        type: 'submit',
                        variant: on ? 'outline' : 'default',
                        size: 'sm',
                      })}
                    </form>`,
                  })}
                  ${CardContent(html`
                    <div class="row tiny muted" style="margin-bottom:.75rem">
                      ${Badge(on ? 'Enabled' : 'Disabled', on ? 'success' : 'outline')}
                      <span>v${row.version}</span>
                      <span>${row.source}</span>
                      ${manifest?.capabilities?.length
                        ? html`<span>reaches: ${manifest.capabilities.join(', ')}</span>`
                        : ''}
                      ${manifest?.homepage ? html`<a href="${manifest.homepage}" rel="noopener">homepage</a>` : ''}
                    </div>
                    ${row.last_error
                      ? Alert(row.last_error, { variant: 'destructive', title: 'This plugin reported a problem' })
                      : ''}
                    ${missingRequired(manifest, registry.config(row.slug))
                      .map((spec) =>
                        Alert(
                          html`<strong>${spec.label}</strong> is empty, so this plugin renders nothing.
                            ${spec.help ?? ''}`,
                          { variant: 'warning', title: 'Not configured' },
                        ),
                      )}
                    ${on && manifest?.settings?.length
                      ? html`<form method="post" action="/admin/plugins/${row.slug}/settings">
                          ${manifest.settings.map((spec) =>
                            pluginField(spec, registry.config(row.slug)[spec.key] ?? spec.default),
                          )}
                          ${Button('Save', { type: 'submit', size: 'sm' })}
                        </form>`
                      : ''}
                  `)}
                `);
              })
            : Card(CardContent(Empty('No plugins found', 'Bundled plugins live in the plugins/ directory.')))}
        </div>
      `,
    );
  });

  app.post('/admin/plugins/:slug/toggle', async (c) => {
    const form = await c.req.parseBody();
    await services.registry.setEnabled(c.req.param('slug'), String(form.enabled ?? '0') === '1');
    return c.redirect('/admin/plugins', 303);
  });

  app.post('/admin/plugins/:slug/settings', async (c) => {
    const slug = c.req.param('slug');
    const discovered = services.registry.plugins.get(slug);
    const specs = discovered?.manifest?.settings ?? [];
    const form = await c.req.parseBody();

    // Only keys the manifest declares are written. A form field a plugin never
    // asked for is not a setting, whatever it is called.
    const config: Record<string, unknown> = { ...services.registry.config(slug) };
    for (const spec of specs) {
      if (spec.type === 'boolean') config[spec.key] = toBool(form[spec.key]);
      else if (spec.type === 'number') config[spec.key] = toInt(form[spec.key], Number(spec.default ?? 0));
      else config[spec.key] = String(form[spec.key] ?? spec.default ?? '');
    }

    await run('UPDATE plugins SET config = ?, updated_at = ? WHERE slug = ?', [
      JSON.stringify(config),
      now(),
      slug,
    ]);
    await services.registry.reload();
    return c.redirect('/admin/plugins', 303);
  });

  // --- Users --------------------------------------------------------------

  app.get('/admin/users', async (c) => {
    const query = (c.req.query('q') ?? '').trim();
    const rows = query
      ? await all<UserRow>(
          `SELECT id, username, email, post_count, is_admin, is_moderator, is_banned, created_at
             FROM users WHERE is_deleted = 0 AND (username_lower LIKE ? OR email_lower LIKE ?)
             ORDER BY created_at DESC LIMIT 100`,
          [`%${query.toLowerCase()}%`, `%${query.toLowerCase()}%`],
        )
      : await all<UserRow>(
          `SELECT id, username, email, post_count, is_admin, is_moderator, is_banned, created_at
             FROM users WHERE is_deleted = 0 ORDER BY created_at DESC LIMIT 100`,
        );

    return page(
      c,
      'Users',
      html`
        <div class="page-head"><h1 class="page-title">Users</h1></div>
        ${Card(html`
          ${CardContent(html`<form method="get" action="/admin/users" class="row">
            <input class="input grow" name="q" value="${query}" placeholder="Search by name or email…" />
            ${Button('Search', { type: 'submit', variant: 'outline' })}
          </form>`)}
          ${CardContent(
            html`<div class="table-wrap"><table class="table">
              <thead><tr><th>User</th><th>Email</th><th>Posts</th><th>Joined</th><th>Role</th><th></th></tr></thead>
              <tbody>
                ${rows.map(
                  (row) => html`<tr>
                    <td><a href="/u/${row.username}">${row.username}</a></td>
                    <td class="tiny muted">${row.email}</td>
                    <td>${row.post_count}</td>
                    <td>${TimeAgo(row.created_at)}</td>
                    <td>
                      ${row.is_admin ? Badge('Admin', 'staff') : row.is_moderator ? Badge('Mod', 'staff') : Badge('Member', 'outline')}
                      ${row.is_banned ? Badge('Banned', 'destructive') : ''}
                    </td>
                    <td>
                      <form method="post" action="/admin/users/${row.id}" class="row">
                        <select class="select" name="role" style="width:auto">
                          <option value="member" ${!row.is_admin && !row.is_moderator ? 'selected' : ''}>Member</option>
                          <option value="moderator" ${row.is_moderator && !row.is_admin ? 'selected' : ''}>Moderator</option>
                          <option value="admin" ${row.is_admin ? 'selected' : ''}>Admin</option>
                        </select>
                        <select class="select" name="banned" style="width:auto">
                          <option value="0" ${row.is_banned ? '' : 'selected'}>Active</option>
                          <option value="1" ${row.is_banned ? 'selected' : ''}>Banned</option>
                        </select>
                        ${Button('Apply', { type: 'submit', variant: 'ghost', size: 'sm' })}
                      </form>
                    </td>
                  </tr>`,
                )}
              </tbody>
            </table></div>`,
            { flush: true },
          )}
        `)}
      `,
    );
  });

  app.post('/admin/users/:id', async (c) => {
    const viewer = c.get('viewer');
    const id = Number(c.req.param('id'));
    const form = await c.req.parseBody();
    const role = String(form.role ?? 'member');
    const banned = String(form.banned ?? '0') === '1';

    // An administrator cannot demote or ban themselves. Without this, one
    // mis-click on a single-admin board locks everybody out of the panel
    // permanently, with no way back in short of editing the database.
    if (viewer.user?.id === id && (role !== 'admin' || banned)) {
      return page(
        c,
        'Users',
        Alert('You cannot remove your own administrator role or ban yourself.', {
          variant: 'destructive',
          title: 'Refused',
        }),
      );
    }

    await run(
      'UPDATE users SET is_admin = ?, is_moderator = ?, is_banned = ? WHERE id = ?',
      [role === 'admin' ? 1 : 0, role === 'admin' || role === 'moderator' ? 1 : 0, banned ? 1 : 0, id],
    );
    await run(
      `INSERT INTO mod_log (actor_id, action, target_type, target_id, detail, created_at)
       VALUES (?, 'user.role', 'user', ?, ?, ?)`,
      [viewer.user?.id ?? null, id, JSON.stringify({ role, banned }), now()],
    );
    return c.redirect('/admin/users', 303);
  });

  // --- Moderation ---------------------------------------------------------

  app.get('/admin/moderation', async (c) => {
    const reports = await all<{
      id: number; target_type: string; target_id: number; reason: string; detail: string | null;
      status: string; created_at: number; reporter: string | null;
    }>(
      `SELECT r.id, r.target_type, r.target_id, r.reason, r.detail, r.status, r.created_at,
              u.username AS reporter
         FROM reports r LEFT JOIN users u ON u.id = r.reporter_id
        WHERE r.status = 'open' ORDER BY r.created_at DESC LIMIT 100`,
    );
    const log = await all<{ id: number; action: string; created_at: number; actor: string | null }>(
      `SELECT m.id, m.action, m.created_at, u.username AS actor
         FROM mod_log m LEFT JOIN users u ON u.id = m.actor_id
        ORDER BY m.created_at DESC LIMIT 30`,
    );

    return page(
      c,
      'Moderation',
      html`
        <div class="page-head"><h1 class="page-title">Moderation</h1></div>
        <div class="stack">
          ${Card(html`${CardHeader('Open reports')}
            ${CardContent(
              reports.length
                ? html`<div class="table-wrap"><table class="table">
                    <thead><tr><th>What</th><th>Reason</th><th>By</th><th>When</th><th></th></tr></thead>
                    <tbody>${reports.map(
                      (report) => html`<tr>
                        <td>${report.target_type} #${report.target_id}</td>
                        <td>${report.reason}${report.detail ? html`<div class="tiny muted">${report.detail}</div>` : ''}</td>
                        <td>${report.reporter ?? 'a guest'}</td>
                        <td>${TimeAgo(report.created_at)}</td>
                        <td>
                          <form method="post" action="/admin/moderation/${report.id}/resolve">
                            ${Button('Resolve', { type: 'submit', variant: 'ghost', size: 'sm' })}
                          </form>
                        </td>
                      </tr>`,
                    )}</tbody>
                  </table></div>`
                : Empty('Nothing waiting', 'Reported posts appear here.'),
              { flush: true },
            )}`)}
          ${Card(html`${CardHeader('Recent actions')}
            ${CardContent(
              log.length
                ? html`<div class="stack">${log.map(
                    (entry) => html`<div class="row-between small">
                      <span>${entry.actor ?? 'system'} — ${entry.action}</span>${TimeAgo(entry.created_at)}
                    </div>`,
                  )}</div>`
                : html`<p class="small muted">Nothing logged yet.</p>`,
            )}`)}
        </div>
      `,
    );
  });

  app.post('/admin/moderation/:id/resolve', async (c) => {
    const viewer = c.get('viewer');
    await run(
      "UPDATE reports SET status = 'resolved', handled_by = ?, handled_at = ? WHERE id = ?",
      [viewer.user?.id ?? null, now(), Number(c.req.param('id'))],
    );
    return c.redirect('/admin/moderation', 303);
  });

  return app;
}

/**
 * A plugin can be enabled, error-free and still do nothing because a setting it
 * cannot work without is blank — which looks identical to a broken plugin from
 * the outside. Saying so on the page is the difference between a two-minute fix
 * and an afternoon.
 */
function missingRequired(
  manifest: { settings?: SettingSpec[] } | null | undefined,
  config: Record<string, unknown>,
): SettingSpec[] {
  return (manifest?.settings ?? []).filter(
    (spec) =>
      spec.type === 'string' &&
      'required' in spec &&
      spec.required === true &&
      !String(config[spec.key] ?? spec.default ?? '').trim(),
  );
}

interface UserRow {
  id: number;
  username: string;
  email: string;
  post_count: number;
  is_admin: number;
  is_moderator: number;
  is_banned: number;
  created_at: number;
}

const MEMBER_POSTING_LABEL: Record<(typeof MEMBER_POSTING)[number], string> = {
  topics: 'Members start topics and reply',
  replies: 'Members reply only',
  none: 'Members read only',
};

function feedBadge(count: number) {
  return count ? Badge(`${count} feed${count === 1 ? '' : 's'}`, 'outline') : '';
}

/**
 * Who may write in a forum. It is a policy on the forum rather than a
 * permission row per group, so it reads the same whichever groups the board
 * has — and staff are always exempt, so a moderator can pin a notice above
 * whatever a feed is posting.
 */
function memberPostingField(current: string) {
  return html`<div class="field">
    <label class="label" for="memberPosting">Member posting</label>
    <select class="select" id="memberPosting" name="memberPosting">
      ${MEMBER_POSTING.map(
        (value) => html`<option value="${value}" ${value === current ? 'selected' : ''}>${MEMBER_POSTING_LABEL[value]}</option>`,
      )}
    </select>
    <div class="field-hint">
      Reply only suits a forum that a feed fills: the stories arrive on their own and members discuss them.
      Staff can always post.
    </div>
  </div>`;
}

/**
 * The overview's Updates card: what is running, what is out, and the buttons.
 *
 * It reads only what the last cycle recorded, never the network, so the
 * overview stays fast and the same whichever process rendered it.
 */
function updatesCard(state: Awaited<ReturnType<typeof updateState>>) {
  const enabled = updatesEnabled();
  const actions = enabled
    ? html`<div class="row">
        <form method="post" action="/admin/updates/check">
          ${Button('Check now', { type: 'submit', variant: 'outline', size: 'sm' })}
        </form>
        ${state.available && state.kind === 'git'
          ? html`<form method="post" action="/admin/updates/apply">
              ${Button(`Update to ${state.latestVersion}`, { type: 'submit', size: 'sm' })}
            </form>`
          : ''}
      </div>`
    : '';

  return Card(html`${CardHeader('Updates', {
      description: html`Running <strong>${state.current}</strong>. Automatic updates are
        <a href="/admin/settings">${state.auto ? 'on' : 'off'}</a>.`,
      actions,
    })}
    ${CardContent(html`
      ${!enabled
        ? html`<p class="small muted">Update checks are switched off in the environment (TSBB_UPDATES).</p>`
        : state.checkedAt === null
          ? html`<p class="small muted">Not checked yet. The board checks a minute after it starts, then every five minutes.</p>`
          : state.available
            ? Alert(
                html`<a href="${state.latestUrl ?? '#'}">Version ${state.latestVersion}</a> is available.
                  ${state.kind === 'git'
                    ? state.auto
                      ? 'It will be installed on the next check, or now with the button above.'
                      : 'Install it with the button above, or run tsbb update on the server.'
                    : 'This board runs from an image, so redeploy it to get the new version.'}`,
                { variant: 'warning', title: 'A new version is out' },
              )
            : html`<p class="small muted">Up to date. Last checked ${TimeAgo(state.checkedAt)}.</p>`}
      ${state.checkError
        ? html`<div style="margin-top:.75rem">${Alert(state.checkError, { variant: 'destructive', title: 'The last check failed' })}</div>`
        : ''}
      ${state.applyError
        ? html`<div style="margin-top:.75rem">${Alert(state.applyError, { variant: 'destructive', title: 'The last update failed' })}</div>`
        : ''}
      ${state.appliedVersion && state.appliedAt
        ? html`<p class="small muted" style="margin-top:.75rem">Last updated to ${state.appliedVersion} ${TimeAgo(state.appliedAt)}.</p>`
        : ''}
    `)}`);
}

/** A board setting rendered from the type of its default value. */
function settingField(key: string, value: unknown, help?: string) {
  const label = key.split('.').pop()?.replace(/([A-Z])/g, ' $1').replace(/^./, (m) => m.toUpperCase()) ?? key;
  const current = (DEFAULT_SETTINGS as Record<string, unknown>)[key];

  if (typeof current === 'boolean') {
    return html`<div class="checkbox-row">
      <input type="checkbox" id="${key}" name="${key}" ${value ? 'checked' : ''} />
      <div><label for="${key}">${label}</label>${help ? html`<div class="field-hint">${help}</div>` : ''}</div>
    </div>`;
  }
  if (
    key === 'posts.defaultFormat' ||
    key === 'registration.mode' ||
    key === 'board.skin' ||
    key === 'board.theme'
  ) {
    const options =
      key === 'posts.defaultFormat'
        ? ['markdown', 'bbcode']
        : key === 'board.skin'
          ? [...SKINS]
          : key === 'board.theme'
            ? ['system', 'light', 'dark']
            : ['open', 'invite', 'closed'];
    return html`<div class="field">
      <label class="label" for="${key}">${label}</label>
      <select class="select" id="${key}" name="${key}">
        ${options.map((option) => html`<option value="${option}" ${value === option ? 'selected' : ''}>${option}</option>`)}
      </select>
      ${help ? html`<div class="field-hint">${help}</div>` : ''}
    </div>`;
  }
  return html`<div class="field">
    <label class="label" for="${key}">${label}</label>
    <input
      class="input"
      id="${key}"
      name="${key}"
      type="${typeof current === 'number' ? 'number' : 'text'}"
      value="${String(value ?? '')}"
    />
    ${help ? html`<div class="field-hint">${help}</div>` : ''}
  </div>`;
}

/**
 * A plugin's settings form, generated from its manifest.
 *
 * A plugin declares what it needs and gets a real form for it — no plugin ships
 * its own admin page, which is what keeps every plugin's configuration looking
 * and behaving the same.
 */
function pluginField(spec: SettingSpec, value: unknown) {
  const id = `plugin-${spec.key}`;
  switch (spec.type) {
    case 'boolean':
      return html`<div class="checkbox-row">
        <input type="checkbox" id="${id}" name="${spec.key}" ${value ? 'checked' : ''} />
        <div>
          <label for="${id}">${spec.label}</label>
          ${spec.help ? html`<div class="field-hint">${spec.help}</div>` : ''}
        </div>
      </div>`;
    case 'select':
      return html`<div class="field">
        <label class="label" for="${id}">${spec.label}</label>
        <select class="select" id="${id}" name="${spec.key}">
          ${spec.options.map(
            (option) => html`<option value="${option.value}" ${value === option.value ? 'selected' : ''}>${option.label}</option>`,
          )}
        </select>
        ${spec.help ? html`<div class="field-hint">${spec.help}</div>` : ''}
      </div>`;
    case 'text':
      return html`<div class="field">
        <label class="label" for="${id}">${spec.label}</label>
        <textarea class="textarea" id="${id}" name="${spec.key}" rows="${spec.rows ?? 4}">${String(value ?? '')}</textarea>
        ${spec.help ? html`<div class="field-hint">${spec.help}</div>` : ''}
      </div>`;
    case 'number':
      return html`<div class="field">
        <label class="label" for="${id}">${spec.label}</label>
        <input class="input" type="number" id="${id}" name="${spec.key}" value="${String(value ?? '')}" />
        ${spec.help ? html`<div class="field-hint">${spec.help}</div>` : ''}
      </div>`;
    default:
      return html`<div class="field">
        <label class="label" for="${id}">${spec.label}</label>
        <input
          class="input"
          type="${spec.secret ? 'password' : 'text'}"
          id="${id}"
          name="${spec.key}"
          value="${String(value ?? '')}"
          placeholder="${spec.placeholder ?? ''}"
        />
        ${spec.help ? html`<div class="field-hint">${spec.help}</div>` : ''}
      </div>`;
  }
}
