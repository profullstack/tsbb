import { Hono } from 'hono';
import type { Context } from 'hono';
import { html } from 'hono/html';
import { createHash, randomBytes } from 'node:crypto';
import { all, now, one, run } from '@tsbb/db';
import {
  avatarUrlFor,
  countTopics,
  listNotifications,
  listTopics,
  markNotificationsRead,
  mintToken,
  NOTIFICATION_LABELS,
  rankFor,
  revokeToken,
  signatureGate,
  unreadCount,
  updateProfile,
  userByUsername,
  usernameTaken,
  normaliseAvatar,
  ImageError,
  formatBytes,
  validateUsername,
  type Settings,
} from '@tsbb/core';
import { renderSignature } from '@tsbb/markup';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  Empty,
  LinkButton,
  Pagination,
  TimeAgo,
  TopicRow,
  trusted,
} from '@tsbb/ui';
import { render, slot, type AppEnv, type Services } from '../context.ts';

/** Only these are ever written to disk, and the extension comes from this map — never from the filename. */
/** The only values the avatar selector may set. Anything else is not a choice. */
const AVATAR_KINDS = new Set(['identicon', 'gravatar', 'upload', 'none']);

const IMAGE_TYPES: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

export function userRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  // --- Uploaded files -----------------------------------------------------

  app.get('/uploads/:name', async (c) => {
    const name = c.req.param('name');
    // The name is one we generated: a content hash plus an extension chosen
    // from the sniffed type. Anything else is refused outright, so there is no
    // path to traverse rather than a traversal that has to be caught.
    if (!/^[0-9a-f]{32}\.(png|jpg|gif|webp)$/.test(name)) return c.notFound();

    const row = await one<{ mime: string; bytes: Uint8Array }>(
      'SELECT mime, bytes FROM uploads WHERE name = ?',
      [name],
    );
    if (!row) return c.notFound();

    return c.body(Buffer.from(row.bytes) as unknown as ArrayBuffer, 200, {
      'content-type': row.mime,
      // The URL is a content hash, so the bytes behind it can never change.
      'cache-control': 'public, max-age=31536000, immutable',
    });
  });

  // --- Profile ------------------------------------------------------------

  app.get('/u/:username', async (c) => {
    const viewer = c.get('viewer');
    const settings = c.get('settings');
    const profile = await userByUsername(c.req.param('username'));
    if (!profile) return c.notFound();

    const page = Math.max(1, Number(c.req.query('page') ?? 1));
    const perPage = 20;
    const [topics, total, rank] = await Promise.all([
      listTopics({ userId: profile.id, limit: perPage, offset: (page - 1) * perPage, viewerId: viewer.user?.id ?? null }),
      countTopics({ userId: profile.id }),
      rankFor(profile),
    ]);

    const gate = signatureGate(profile, settings);
    const tabs = await slot(c, services, 'profile:tabs', { profile });

    const body = html`
      <div class="profile-header">
        ${Avatar(profile, 'xl')}
        <div class="grow">
          <h1 class="page-title">${profile.displayName ?? profile.username}</h1>
          <div class="row small muted">
            <span>@${profile.username}</span>
            ${profile.isAdmin ? Badge('Admin', 'staff') : profile.isModerator ? Badge('Moderator', 'staff') : ''}
            ${rank ? Badge(rank.title, 'secondary') : ''}
            ${profile.isBanned ? Badge('Banned', 'destructive') : ''}
          </div>
          ${profile.bio ? html`<p class="small" style="margin-top:.5rem;max-width:44rem">${profile.bio}</p>` : ''}
          <div class="profile-stats">
            <div class="profile-stat"><strong>${profile.postCount}</strong><span>posts</span></div>
            <div class="profile-stat"><strong>${profile.topicCount}</strong><span>topics</span></div>
            <div class="profile-stat"><strong>${profile.reactionCount}</strong><span>reactions</span></div>
            <div class="profile-stat">
              <strong>${new Date(profile.createdAt).toISOString().slice(0, 10)}</strong><span>joined</span>
            </div>
          </div>
        </div>
        <div class="row">
          ${viewer.user && viewer.user.id !== profile.id
            ? LinkButton('Message', `/messages/new?to=${profile.username}`, { variant: 'outline', size: 'sm' })
            : ''}
          ${viewer.user?.id === profile.id ? LinkButton('Edit profile', '/settings', { size: 'sm' }) : ''}
        </div>
      </div>
      ${trusted(tabs)}
      ${gate.visible && profile.signature
        ? html`<div class="card" style="margin-bottom:1rem">
            <div class="card-content">
              <div class="tiny muted" style="margin-bottom:.375rem">Signature</div>
              <div class="post-signature" style="margin:0;border:none;padding:0">
                ${trusted(renderSignature(profile.signature, 'markdown', { mentionUrl: (u) => `/u/${u}` }))}
              </div>
            </div>
          </div>`
        : ''}
      ${Card(html`${CardHeader(`Topics by ${profile.username}`)}
        ${CardContent(
          topics.length ? topics.map((t) => TopicRow(t)) : Empty('No topics yet'),
          { flush: true },
        )}`)}
      ${Pagination(page, Math.ceil(total / perPage), (p) => `/u/${profile.username}?page=${p}`)}`;

    return render(c, services, {
      title: profile.displayName ?? profile.username,
      description: profile.bio ?? `${profile.username} on this board`,
      feedUrl: `/u/${profile.username}/feed.xml`,
      body,
    });
  });

  // --- Members ------------------------------------------------------------

  app.get('/members', async (c) => {
    const page = Math.max(1, Number(c.req.query('page') ?? 1));
    const perPage = 40;
    const sort = c.req.query('sort') === 'new' ? 'created_at DESC' : 'post_count DESC, id';
    const rows = await all<{
      id: number; username: string; display_name: string | null; email: string;
      avatar_kind: string; avatar_url: string | null; post_count: number;
      created_at: number; last_seen_at: number | null; is_admin: number; is_moderator: number;
    }>(
      `SELECT id, username, display_name, email, avatar_kind, avatar_url, post_count,
              created_at, last_seen_at, is_admin, is_moderator
         FROM users WHERE is_deleted = 0 ORDER BY ${sort} LIMIT ? OFFSET ?`,
      [perPage, (page - 1) * perPage],
    );
    const total = Number(
      (await one<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE is_deleted = 0'))?.n ?? 0,
    );

    const body = html`
      <div class="page-head">
        <div><h1 class="page-title">Members</h1><p class="page-subtitle">${total} accounts</p></div>
        <div class="tabs-list">
          <a class="${c.req.query('sort') === 'new' ? 'tabs-trigger' : 'tabs-trigger active'}" href="/members">Most posts</a>
          <a class="${c.req.query('sort') === 'new' ? 'tabs-trigger active' : 'tabs-trigger'}" href="/members?sort=new">Newest</a>
        </div>
      </div>
      ${Card(
        CardContent(
          html`<div class="table-wrap">
            <table class="table">
              <thead><tr><th>Member</th><th>Posts</th><th>Joined</th><th>Last seen</th></tr></thead>
              <tbody>
                ${rows.map(
                  (row) => html`<tr>
                    <td>
                      <span class="row" style="gap:.5rem">
                        ${Avatar(
                          {
                            id: row.id, username: row.username, email: row.email,
                            avatarKind: row.avatar_kind as never, avatarUrl: row.avatar_url,
                          },
                          'sm',
                        )}
                        <a href="/u/${row.username}">${row.display_name ?? row.username}</a>
                        ${row.is_admin ? Badge('Admin', 'staff') : row.is_moderator ? Badge('Mod', 'staff') : ''}
                      </span>
                    </td>
                    <td>${row.post_count}</td>
                    <td>${TimeAgo(row.created_at)}</td>
                    <td>${TimeAgo(row.last_seen_at)}</td>
                  </tr>`,
                )}
              </tbody>
            </table>
          </div>`,
          { flush: true },
        ),
      )}
      ${Pagination(page, Math.ceil(total / perPage), (p) => `/members?page=${p}${c.req.query('sort') ? '&sort=new' : ''}`)}`;

    return render(c, services, { title: 'Members', body });
  });

  // --- Notifications ------------------------------------------------------

  app.get('/notifications', async (c) => {
    const viewer = c.get('viewer');
    if (!viewer.user) return c.redirect('/login?redirect=%2Fnotifications', 302);
    const rows = await listNotifications(viewer.user.id, { limit: 50 });
    const unread = await unreadCount(viewer.user.id);

    const body = html`
      <div class="page-head">
        <div>
          <h1 class="page-title">Notifications</h1>
          <p class="page-subtitle">${unread} unread</p>
        </div>
        ${unread
          ? html`<form action="/notifications/read" method="post">
              ${Button('Mark all read', { type: 'submit', variant: 'outline', size: 'sm' })}
            </form>`
          : ''}
      </div>
      ${Card(
        CardContent(
          rows.length
            ? rows.map(
                (row) => html`<div class="${row.readAt ? 'topic-row' : 'topic-row unread'}">
                  <span></span>
                  <div class="grow">
                    <a class="topic-title" href="${row.url ?? '/'}">${row.title ?? 'Activity'}</a>
                    <div class="topic-sub">
                      <span>${row.kind}</span><span class="dot" aria-hidden="true"></span>${TimeAgo(row.createdAt)}
                    </div>
                    ${row.excerpt ? html`<div class="small muted">${row.excerpt}</div>` : ''}
                  </div>
                  <span></span>
                </div>`,
              )
            : Empty('Nothing yet', 'Replies to topics you follow and mentions of your name land here.'),
          { flush: true },
        ),
      )}`;

    return render(c, services, { title: 'Notifications', body });
  });

  app.post('/notifications/read', async (c) => {
    const viewer = c.get('viewer');
    if (!viewer.user) return c.redirect('/login', 302);
    await markNotificationsRead(viewer.user.id);
    return c.redirect('/notifications', 303);
  });

  // --- Settings -----------------------------------------------------------

  app.get('/settings', async (c) =>
    settingsPage(c, services, {
      saved: c.req.query('saved') === '1',
      note: c.req.query('note') ?? undefined,
    }),
  );

  app.post('/settings', async (c) => {
    const viewer = c.get('viewer');
    if (!viewer.user) return c.redirect('/login', 302);
    const form = await c.req.parseBody();
    const settings = c.get('settings');

    const wantedName = String(form.username ?? '').trim();
    if (wantedName && wantedName.toLowerCase() !== viewer.user.username.toLowerCase()) {
      const check = validateUsername(wantedName, settings);
      if (!check.ok) return settingsPage(c, services, { error: check.reason });
      if (await usernameTaken(wantedName)) {
        return settingsPage(c, services, { error: 'That username is taken.' });
      }
      await run('UPDATE users SET username = ?, username_lower = ? WHERE id = ?', [
        wantedName,
        wantedName.toLowerCase(),
        viewer.user.id,
      ]);
    }

    const maxSignature = Number(settings['signatures.maxLength'] ?? 400);
    const patch: Parameters<typeof updateProfile>[1] = {
      displayName: String(form.displayName ?? '').trim() || null,
      location: String(form.location ?? '').trim() || null,
      website: String(form.website ?? '').trim() || null,
      bio: String(form.bio ?? '').trim().slice(0, 1000) || null,
      signature: String(form.signature ?? '').trim().slice(0, maxSignature) || null,
    };

    /*
     * Only touch the avatar when the form actually carried the field.
     *
     * A missing SELECT means "this form was not editing that", which is the
     * opposite of a missing CHECKBOX, where absence means "off". Defaulting the
     * absent case to 'identicon' meant the profile form — which has no avatar
     * field at all — silently reset the avatar on every save, and a refresh
     * re-submitted the POST and did it again.
     */
    if (typeof form.avatarKind === 'string' && AVATAR_KINDS.has(form.avatarKind)) {
      patch.avatarKind = form.avatarKind;
    }

    await updateProfile(viewer.user.id, patch);

    await run('UPDATE user_prefs SET show_signatures = ?, show_avatars = ?, auto_subscribe = ?, updated_at = ? WHERE user_id = ?', [
      form.showSignatures ? 1 : 0,
      form.showAvatars ? 1 : 0,
      form.autoSubscribe ? 1 : 0,
      now(),
      viewer.user.id,
    ]);

    // Redirect rather than render: otherwise refreshing the page re-submits the
    // whole form, which is how a save can silently happen again and again.
    return c.redirect('/settings?saved=1', 303);
  });

  /**
   * Avatar upload. The stored filename is a hash of the bytes plus an extension
   * chosen from the *sniffed* type, never from what the browser called the file
   * — so an upload named `x.php` or `../../etc/passwd` cannot become either.
   */
  app.post('/settings/avatar', async (c) => {
    const viewer = c.get('viewer');
    if (!viewer.user) return c.redirect('/login', 302);
    const settings = c.get('settings');
    if (settings['avatars.allowUpload'] === false) {
      return settingsPage(c, services, { error: 'Avatar uploads are turned off on this board.' });
    }

    const form = await c.req.parseBody();
    const file = form.avatar;
    if (!(file instanceof File) || file.size === 0) {
      return settingsPage(c, services, { error: 'Choose an image to upload.' });
    }

    const maxBytes = Number(settings['avatars.maxBytes'] ?? 512_000);
    if (file.size > maxBytes) {
      return settingsPage(c, services, {
        error: `That image is ${formatBytes(file.size)}; uploads are capped at ${formatBytes(maxBytes)}.`,
      });
    }

    const uploaded = Buffer.from(await file.arrayBuffer());
    if (!sniffImage(uploaded)) {
      // The declared content-type is attacker-controlled, so the magic bytes
      // decide. A file that is not actually an image is never decoded.
      return settingsPage(c, services, { error: 'That file is not a PNG, JPEG, GIF or WebP image.' });
    }

    /*
     * Crunch it here, on the way in. An avatar is shown at 80px at the very
     * largest, so whatever came off a phone is downscaled to a 256px WebP —
     * typically a few kilobytes — and only that is kept. The original is never
     * stored, which is what keeps every page fast no matter what people upload.
     */
    let image;
    try {
      image = await normaliseAvatar(uploaded);
    } catch (error) {
      return settingsPage(c, services, {
        error: error instanceof ImageError ? error.message : 'We could not process that image.',
      });
    }

    const name = `${createHash('sha256').update(image.bytes).digest('hex').slice(0, 32)}.webp`;

    // Keyed by the hash of the CRUNCHED bytes, so two people uploading the same
    // picture at different resolutions still share one row.
    await run(
      `INSERT INTO uploads (name, mime, bytes, size_bytes, user_id, kind, created_at)
       VALUES (?, ?, ?, ?, ?, 'avatar', ?)
       ON CONFLICT (name) DO NOTHING`,
      [name, image.mime, image.bytes, image.bytes.length, viewer.user.id, now()],
    );
    await updateProfile(viewer.user.id, { avatarKind: 'upload', avatarUrl: `/uploads/${name}` });
    const note = `Resized to ${image.width}px — ${formatBytes(image.originalBytes)} became ${formatBytes(image.bytes.length)}.`;
    return c.redirect(`/settings?saved=1&note=${encodeURIComponent(note)}`, 303);
  });

  app.post('/settings/notifications', async (c) => {
    const viewer = c.get('viewer');
    if (!viewer.user) return c.redirect('/login', 302);
    const form = await c.req.parseBody();
    for (const kind of Object.keys(NOTIFICATION_LABELS)) {
      await run(
        `INSERT INTO notification_prefs (user_id, kind, in_app, email) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, kind) DO UPDATE SET in_app = excluded.in_app, email = excluded.email`,
        [viewer.user.id, kind, form[`inapp_${kind}`] ? 1 : 0, form[`email_${kind}`] ? 1 : 0],
      );
    }
    await run('UPDATE user_prefs SET email_digest = ?, updated_at = ? WHERE user_id = ?', [
      String(form.digest ?? 'instant'),
      now(),
      viewer.user.id,
    ]);
    return c.redirect('/settings/notifications', 303);
  });

  app.get('/settings/notifications', async (c) => {
    const viewer = c.get('viewer');
    if (!viewer.user) return c.redirect('/login?redirect=%2Fsettings%2Fnotifications', 302);
    const prefs = await all<{ kind: string; in_app: number; email: number }>(
      'SELECT kind, in_app, email FROM notification_prefs WHERE user_id = ?',
      [viewer.user.id],
    );
    const byKind = new Map(prefs.map((p) => [p.kind, p]));
    const digest = (
      await one<{ email_digest: string }>('SELECT email_digest FROM user_prefs WHERE user_id = ?', [
        viewer.user.id,
      ])
    )?.email_digest ?? 'instant';

    const body = html`<div style="max-width:44rem">
      ${Card(html`
        ${CardHeader('What you are emailed about', {
          description: 'In-app notifications always appear in your inbox; these control the email.',
        })}
        ${CardContent(html`<form method="post" action="/settings/notifications">
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Event</th><th>Inbox</th><th>Email</th></tr></thead>
              <tbody>
                ${Object.entries(NOTIFICATION_LABELS).map(([kind, label]) => {
                  const pref = byKind.get(kind);
                  const inApp = pref ? pref.in_app === 1 : true;
                  const email = pref ? pref.email === 1 : true;
                  return html`<tr>
                    <td>${label}</td>
                    <td><input type="checkbox" name="inapp_${kind}" ${inApp ? 'checked' : ''} /></td>
                    <td><input type="checkbox" name="email_${kind}" ${email ? 'checked' : ''} /></td>
                  </tr>`;
                })}
              </tbody>
            </table>
          </div>
          <div class="field" style="margin-top:1rem">
            <label class="label" for="digest">How often</label>
            <select class="select" id="digest" name="digest">
              <option value="instant" ${digest === 'instant' ? 'selected' : ''}>As it happens</option>
              <option value="daily" ${digest === 'daily' ? 'selected' : ''}>A daily summary</option>
              <option value="never" ${digest === 'never' ? 'selected' : ''}>Never email me</option>
            </select>
          </div>
          ${Button('Save', { type: 'submit' })}
        </form>`)}
      `)}
    </div>`;

    return render(c, services, { title: 'Notification settings', body });
  });

  // --- API tokens, for the terminal client and scripts --------------------

  app.post('/settings/tokens', async (c) => {
    const viewer = c.get('viewer');
    if (!viewer.user) return c.redirect('/login', 302);
    const form = await c.req.parseBody();
    const token = await mintToken({
      userId: viewer.user.id,
      label: String(form.label ?? 'Token').slice(0, 60),
    });
    // Shown once. It is stored hashed, so it genuinely cannot be shown again.
    return settingsPage(c, services, { newToken: token });
  });

  app.post('/settings/tokens/:id/revoke', async (c) => {
    const viewer = c.get('viewer');
    if (!viewer.user) return c.redirect('/login', 302);
    await revokeToken(viewer.user.id, Number(c.req.param('id')));
    return c.redirect('/settings', 303);
  });

  return app;
}

/** Magic bytes, because a declared content-type is whatever the client says. */
function sniffImage(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

async function settingsPage(
  c: Context<AppEnv>,
  services: Services,
  state: { saved?: boolean; error?: string; newToken?: string; note?: string } = {},
) {
  const viewer = c.get('viewer');
  if (!viewer.user) return c.redirect('/login?redirect=%2Fsettings', 302);
  const settings = c.get('settings') as Settings;
  const user = viewer.user;
  const gate = signatureGate(user, settings);

  const tokens = await all<{ id: number; label: string | null; created_at: number; last_used_at: number | null }>(
    'SELECT id, label, created_at, last_used_at FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC',
    [user.id],
  );
  const prefs = await one<{ show_signatures: number; show_avatars: number; auto_subscribe: number }>(
    'SELECT show_signatures, show_avatars, auto_subscribe FROM user_prefs WHERE user_id = ?',
    [user.id],
  );

  const body = html`<div style="max-width:44rem" class="stack">
    ${state.saved ? Alert(state.note ?? 'Saved.', { variant: 'success' }) : ''}
    ${state.error ? Alert(state.error, { variant: 'destructive' }) : ''}
    ${state.newToken
      ? Alert(
          html`Copy it now — it is stored hashed and cannot be shown again.
            <div class="textarea mono" style="margin-top:.5rem;min-height:auto;word-break:break-all">${state.newToken}</div>`,
          { variant: 'warning', title: 'Your new token' },
        )
      : ''}

    <div class="tabs-list">
      <a class="tabs-trigger active" href="/settings">Profile</a>
      <a class="tabs-trigger" href="/settings/notifications">Notifications</a>
    </div>

    ${Card(html`
      ${CardHeader('Your picture')}
      ${CardContent(html`
        <div class="row" style="gap:1.25rem;align-items:flex-start">
          ${Avatar(user, 'xl')}
          <div class="grow stack">
            <form method="post" action="/settings/avatar" enctype="multipart/form-data" class="stack">
              <div class="field">
                <label class="label" for="avatar">Upload an image</label>
                <input class="input" type="file" id="avatar" name="avatar" accept="image/png,image/jpeg,image/gif,image/webp" />
                <div class="field-hint">
                  PNG, JPEG, GIF or WebP, up to ${formatBytes(Number(settings['avatars.maxBytes'] ?? 10_000_000))}.
                  Large images are fine — they are resized to
                  ${Number(settings['avatars.size'] ?? 256)}px on upload.
                </div>
              </div>
              ${Button('Upload', { type: 'submit', size: 'sm' })}
            </form>
            <form method="post" action="/settings" class="row">
              <select class="select" name="avatarKind" style="width:auto">
                <option value="identicon" ${user.avatarKind === 'identicon' ? 'selected' : ''}>Generated pattern</option>
                <option value="gravatar" ${user.avatarKind === 'gravatar' ? 'selected' : ''}>Gravatar</option>
                <option value="upload" ${user.avatarKind === 'upload' ? 'selected' : ''}>My upload</option>
              </select>
              <input type="hidden" name="username" value="${user.username}" />
              <input type="hidden" name="displayName" value="${user.displayName ?? ''}" />
              <input type="hidden" name="signature" value="${user.signature ?? ''}" />
              ${Button('Use this', { type: 'submit', variant: 'outline', size: 'sm' })}
            </form>
          </div>
        </div>
      `)}
    `)}

    ${Card(html`
      ${CardHeader('Profile')}
      ${CardContent(html`<form method="post" action="/settings">
        <div class="field">
          <label class="label" for="username">Username</label>
          <input class="input" id="username" name="username" value="${user.username}" />
        </div>
        <div class="field">
          <label class="label" for="displayName">Display name</label>
          <input class="input" id="displayName" name="displayName" value="${user.displayName ?? ''}" />
          <div class="field-hint">Shown instead of your username where there is room for it.</div>
        </div>
        <div class="field">
          <label class="label" for="location">Location</label>
          <input class="input" id="location" name="location" value="${user.location ?? ''}" />
        </div>
        <div class="field">
          <label class="label" for="website">Website</label>
          <input class="input" id="website" name="website" type="url" value="${user.website ?? ''}" />
        </div>
        <div class="field">
          <label class="label" for="bio">About you</label>
          <textarea class="textarea" id="bio" name="bio" rows="4">${user.bio ?? ''}</textarea>
        </div>

        <div class="field">
          <label class="label" for="signature">Signature</label>
          <textarea class="textarea mono" id="signature" name="signature" rows="3"
            maxlength="${Number(settings['signatures.maxLength'] ?? 400)}">${user.signature ?? ''}</textarea>
          <div class="${gate.remaining > 0 ? 'field-hint' : 'field-hint'}">
            ${gate.remaining > 0
              ? html`Shown under your posts once you have <strong>${gate.minPosts}</strong> posts —
                  ${gate.remaining} to go. You can write it now.`
              : html`Shown under every post you write. Markdown, up to four lines, no images.`}
          </div>
        </div>

        <div class="checkbox-row">
          <input type="checkbox" id="showSignatures" name="showSignatures" ${prefs?.show_signatures !== 0 ? 'checked' : ''} />
          <label for="showSignatures">Show other people's signatures</label>
        </div>
        <div class="checkbox-row">
          <input type="checkbox" id="showAvatars" name="showAvatars" ${prefs?.show_avatars !== 0 ? 'checked' : ''} />
          <label for="showAvatars">Show avatars</label>
        </div>
        <div class="checkbox-row">
          <input type="checkbox" id="autoSubscribe" name="autoSubscribe" ${prefs?.auto_subscribe !== 0 ? 'checked' : ''} />
          <label for="autoSubscribe">Follow topics I post in</label>
        </div>

        <div style="margin-top:1rem">${Button('Save changes', { type: 'submit' })}</div>
      </form>`)}
    `)}

    ${Card(html`
      ${CardHeader('API tokens', {
        description: 'For the terminal client and scripts. A token can never do anything an administrator can.',
      })}
      ${CardContent(html`
        ${tokens.length
          ? html`<div class="table-wrap"><table class="table">
              <thead><tr><th>Label</th><th>Created</th><th>Last used</th><th></th></tr></thead>
              <tbody>${tokens.map(
                (token) => html`<tr>
                  <td>${token.label ?? 'Token'}</td>
                  <td>${TimeAgo(token.created_at)}</td>
                  <td>${TimeAgo(token.last_used_at)}</td>
                  <td>
                    <form method="post" action="/settings/tokens/${token.id}/revoke">
                      ${Button('Revoke', { type: 'submit', variant: 'ghost', size: 'sm' })}
                    </form>
                  </td>
                </tr>`,
              )}</tbody>
            </table></div>`
          : html`<p class="small muted">No tokens yet. The terminal client makes its own when you sign in with it.</p>`}
        <form method="post" action="/settings/tokens" class="row" style="margin-top:.75rem">
          <input class="input" name="label" placeholder="What is it for?" style="max-width:16rem" />
          ${Button('Create a token', { type: 'submit', variant: 'outline', size: 'sm' })}
        </form>
      `)}
    `)}
  </div>`;

  return render(c, services, { title: 'Settings', body });
}
