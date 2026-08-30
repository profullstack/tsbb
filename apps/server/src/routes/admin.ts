import { Hono } from 'hono';
import type { Context } from 'hono';
import { html, raw } from 'hono/html';
import { all, now, one, run } from '@tsbb/db';
import {
  allForums,
  createForum,
  DEFAULT_SETTINGS,
  loadSettings,
  recountForum,
  setSettings,
  toInt,
  toBool,
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
  TimeAgo,
} from '@tsbb/ui';
import { render, slot, type AppEnv, type Services } from '../context.ts';

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

    return page(
      c,
      'Overview',
      html`
        <div class="page-head"><h1 class="page-title">Overview</h1></div>
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

  // --- Board settings -----------------------------------------------------

  const SETTING_GROUPS: { title: string; keys: string[] }[] = [
    { title: 'Identity', keys: ['board.name', 'board.tagline', 'board.description'] },
    { title: 'Registration', keys: ['registration.mode', 'registration.minUsernameLength', 'registration.maxUsernameLength'] },
    { title: 'Posting', keys: ['posts.defaultFormat', 'posts.perPage', 'posts.minLength', 'posts.maxLength', 'posts.editWindowMinutes', 'posts.floodSeconds', 'topics.perPage', 'topics.titleMaxLength'] },
    { title: 'Signatures', keys: ['signatures.enabled', 'signatures.minPosts', 'signatures.maxLength'] },
    { title: 'Avatars', keys: ['avatars.enabled', 'avatars.allowUpload', 'avatars.allowGravatar', 'avatars.maxBytes'] },
    { title: 'Notifications', keys: ['notifications.emailEnabled', 'notifications.mentionsEnabled'] },
    { title: 'Feeds and search', keys: ['feeds.enabled', 'feeds.itemLimit', 'search.enabled', 'search.minLength'] },
  ];

  const HELP: Record<string, string> = {
    'signatures.minPosts':
      'How many posts before a signature is shown. A new account with a link-filled signature is the shape of every piece of forum spam, so this is 10 by default.',
    'posts.floodSeconds': 'Seconds between posts by the same account. 0 turns flood control off.',
    'posts.editWindowMinutes': 'How long an author may edit their own post. 0 means forever.',
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
            </span>
          </td>
          <td class="tiny muted">${forum.slug}</td>
          <td>${forum.topicCount}</td>
          <td>${forum.postCount}</td>
          <td>
            <form method="post" action="/admin/forums/${forum.id}/delete"
              onsubmit="return confirm('Delete ${escapeHtml(forum.name)} and everything in it?')">
              ${Button('Delete', { type: 'submit', variant: 'ghost', size: 'sm' })}
            </form>
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
    });
    return c.redirect('/admin/forums', 303);
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
  if (key === 'posts.defaultFormat' || key === 'registration.mode') {
    const options = key === 'posts.defaultFormat' ? ['markdown', 'bbcode'] : ['open', 'invite', 'closed'];
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
