import { Hono } from 'hono';
import { html } from 'hono/html';
import { now, run } from '@tsbb/db';
import {
  ancestryOf,
  audit,
  breadcrumb,
  canEditPost,
  createTopic,
  deletePost,
  editPost,
  forumBySlug,
  notifyNewPost,
  postById,
  PostError,
  recountUser,
  reply,
  resolvePermissions,
  setSubscribed,
  topicById,
  userById,
  type Settings,
} from '@tsbb/core';
import { quoteBody } from '@tsbb/markup';
import { Alert, Button, Card, CardContent, CardHeader, LinkButton, trusted } from '@tsbb/ui';
import type { BodyFormat, Viewer } from '@tsbb/plugin-api';
import { render, slot, type AppEnv, type Services } from '../context.ts';
import { forbidden } from './board.ts';

function topicIdFromHandle(handle: string): number {
  const id = Number.parseInt(handle.slice(handle.lastIndexOf('-') + 1), 10);
  return Number.isFinite(id) ? id : 0;
}

function clientIp(c: { req: { header: (n: string) => string | undefined } }): string | null {
  return (
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    null
  );
}

export function writeRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  // --- New topic ----------------------------------------------------------

  app.get('/f/:slug/new', async (c) => {
    const viewer = c.get('viewer');
    const forum = await forumBySlug(c.req.param('slug'));
    if (!forum) return c.notFound();
    if (!viewer.user) return c.redirect(`/login?redirect=${encodeURIComponent(c.req.path)}`, 302);

    const permissions = await resolvePermissions(viewer, forum, await ancestryOf(forum.id));
    if (!permissions.canPost || forum.isLocked) {
      return forbidden(c, services, 'You cannot start a topic in this forum.');
    }

    return render(c, services, {
      title: `New topic in ${forum.name}`,
      body: composerPage(c, services, {
        action: `/f/${forum.slug}/new`,
        heading: `New topic in ${forum.name}`,
        withTitle: true,
        settings: c.get('settings'),
        submit: 'Post topic',
        cancelHref: `/f/${forum.slug}`,
        toolbar: await slot(c, services, 'composer:toolbar'),
      }),
    });
  });

  app.post('/f/:slug/new', async (c) => {
    const viewer = c.get('viewer');
    const forum = await forumBySlug(c.req.param('slug'));
    if (!forum) return c.notFound();
    if (!viewer.user) return c.redirect('/login', 302);

    const permissions = await resolvePermissions(viewer, forum, await ancestryOf(forum.id));
    if (!permissions.canPost || forum.isLocked) {
      return forbidden(c, services, 'You cannot start a topic in this forum.');
    }

    const form = await c.req.parseBody();
    try {
      const { topic, post } = await createTopic({
        forum,
        viewer,
        title: String(form.title ?? ''),
        body: String(form.body ?? ''),
        format: pickFormat(form.format, c.get('settings')),
        ip: clientIp(c),
        bus: services.registry.bus,
      });
      await notifyNewPost({ post, topic, viewer, baseUrl: services.baseUrl, bus: services.registry.bus });
      return c.redirect(`/t/${topic.slug}-${topic.id}`, 303);
    } catch (error) {
      return composerError(c, services, error, {
        action: `/f/${forum.slug}/new`,
        heading: `New topic in ${forum.name}`,
        withTitle: true,
        submit: 'Post topic',
        cancelHref: `/f/${forum.slug}`,
        title: String(form.title ?? ''),
        body: String(form.body ?? ''),
      });
    }
  });

  // --- Reply --------------------------------------------------------------

  app.get('/t/:handle/reply', async (c) => {
    const viewer = c.get('viewer');
    const topic = await topicById(topicIdFromHandle(c.req.param('handle')));
    if (!topic) return c.notFound();
    if (!viewer.user) return c.redirect(`/login?redirect=${encodeURIComponent(c.req.path)}`, 302);

    const forum = (await breadcrumb(topic.forumId)).at(-1);
    if (!forum) return c.notFound();
    const permissions = await resolvePermissions(viewer, forum, await ancestryOf(forum.id));
    if (!permissions.canReply || topic.isLocked) {
      return forbidden(c, services, 'You cannot reply to this topic.');
    }

    // Quoting composes the reply in the format the *replier* writes in, not the
    // format the quoted post happened to use.
    let prefill = '';
    const quoteId = Number(c.req.query('quote') ?? 0);
    if (quoteId) {
      const quoted = await postById(quoteId);
      const author = quoted?.userId ? await userById(quoted.userId) : null;
      if (quoted) {
        prefill = quoteBody({
          author: author?.username ?? 'Anonymous',
          body: quoted.body,
          sourceFormat: quoted.bodyFormat,
          targetFormat: pickFormat(undefined, c.get('settings')),
        });
      }
    }

    return render(c, services, {
      title: `Reply to ${topic.title}`,
      body: composerPage(c, services, {
        action: `/t/${topic.slug}-${topic.id}/reply`,
        heading: `Reply to ${topic.title}`,
        withTitle: false,
        settings: c.get('settings'),
        submit: 'Post reply',
        cancelHref: `/t/${topic.slug}-${topic.id}`,
        body: prefill,
        replyTo: Number(c.req.query('to') ?? 0) || undefined,
        toolbar: await slot(c, services, 'composer:toolbar'),
      }),
    });
  });

  app.post('/t/:handle/reply', async (c) => {
    const viewer = c.get('viewer');
    const topic = await topicById(topicIdFromHandle(c.req.param('handle')));
    if (!topic) return c.notFound();
    if (!viewer.user) return c.redirect('/login', 302);

    const forum = (await breadcrumb(topic.forumId)).at(-1);
    if (!forum) return c.notFound();
    const permissions = await resolvePermissions(viewer, forum, await ancestryOf(forum.id));
    if (!permissions.canReply || topic.isLocked) {
      return forbidden(c, services, 'You cannot reply to this topic.');
    }

    const form = await c.req.parseBody();
    try {
      const post = await reply({
        topic,
        viewer,
        body: String(form.body ?? ''),
        format: pickFormat(form.format, c.get('settings')),
        replyToId: Number(form.replyTo ?? 0) || null,
        ip: clientIp(c),
        bus: services.registry.bus,
      });
      await notifyNewPost({ post, topic, viewer, baseUrl: services.baseUrl, bus: services.registry.bus });
      return c.redirect(`/t/${topic.slug}-${topic.id}/p/${post.id}#p${post.id}`, 303);
    } catch (error) {
      return composerError(c, services, error, {
        action: `/t/${topic.slug}-${topic.id}/reply`,
        heading: `Reply to ${topic.title}`,
        withTitle: false,
        submit: 'Post reply',
        cancelHref: `/t/${topic.slug}-${topic.id}`,
        body: String(form.body ?? ''),
      });
    }
  });

  // --- Edit / delete ------------------------------------------------------

  app.get('/p/:id/edit', async (c) => {
    const viewer = c.get('viewer');
    const post = await postById(Number(c.req.param('id')), true);
    if (!post) return c.notFound();
    const forum = (await breadcrumb(post.forumId)).at(-1);
    if (!forum) return c.notFound();
    const permissions = await resolvePermissions(viewer, forum, await ancestryOf(forum.id));
    const settings = c.get('settings');
    if (!canEditPost(viewer, permissions, post, Number(settings['posts.editWindowMinutes'] ?? 0))) {
      return forbidden(c, services, 'You cannot edit this post.');
    }
    const topic = await topicById(post.topicId, true);

    return render(c, services, {
      title: 'Edit post',
      body: composerPage(c, services, {
        action: `/p/${post.id}/edit`,
        heading: 'Edit post',
        withTitle: false,
        settings,
        submit: 'Save changes',
        cancelHref: topic ? `/t/${topic.slug}-${topic.id}/p/${post.id}` : '/',
        body: post.body,
        withReason: true,
        toolbar: await slot(c, services, 'composer:toolbar'),
      }),
    });
  });

  app.post('/p/:id/edit', async (c) => {
    const viewer = c.get('viewer');
    const post = await postById(Number(c.req.param('id')), true);
    if (!post) return c.notFound();
    const forum = (await breadcrumb(post.forumId)).at(-1);
    if (!forum) return c.notFound();
    const permissions = await resolvePermissions(viewer, forum, await ancestryOf(forum.id));
    const settings = c.get('settings');
    if (!canEditPost(viewer, permissions, post, Number(settings['posts.editWindowMinutes'] ?? 0))) {
      return forbidden(c, services, 'You cannot edit this post.');
    }

    const form = await c.req.parseBody();
    const topic = await topicById(post.topicId, true);
    try {
      await editPost({
        post,
        viewer,
        body: String(form.body ?? ''),
        reason: String(form.reason ?? '') || null,
        bus: services.registry.bus,
      });
      return c.redirect(topic ? `/t/${topic.slug}-${topic.id}/p/${post.id}#p${post.id}` : '/', 303);
    } catch (error) {
      return composerError(c, services, error, {
        action: `/p/${post.id}/edit`,
        heading: 'Edit post',
        withTitle: false,
        submit: 'Save changes',
        cancelHref: topic ? `/t/${topic.slug}-${topic.id}` : '/',
        body: String(form.body ?? ''),
      });
    }
  });

  app.post('/p/:id/delete', async (c) => {
    const viewer = c.get('viewer');
    const post = await postById(Number(c.req.param('id')), true);
    if (!post) return c.notFound();
    const forum = (await breadcrumb(post.forumId)).at(-1);
    if (!forum) return c.notFound();
    const permissions = await resolvePermissions(viewer, forum, await ancestryOf(forum.id));
    const settings = c.get('settings');
    if (!canEditPost(viewer, permissions, post, Number(settings['posts.editWindowMinutes'] ?? 0))) {
      return forbidden(c, services, 'You cannot delete this post.');
    }
    const topic = await topicById(post.topicId, true);
    await deletePost(post.id, viewer, services.registry.bus);
    return c.redirect(topic ? `/t/${topic.slug}-${topic.id}` : '/', 303);
  });

  // --- Reactions and subscriptions ---------------------------------------

  app.post('/p/:id/react', async (c) => {
    const viewer = c.get('viewer');
    if (!viewer.user) return c.redirect('/login', 302);
    const post = await postById(Number(c.req.param('id')));
    if (!post) return c.notFound();

    // A second press removes the reaction, so the same control both adds and
    // withdraws it — one button, no separate "unlike".
    const existing = await run(
      "DELETE FROM reactions WHERE post_id = ? AND user_id = ? AND kind = 'like' RETURNING post_id",
      [post.id, viewer.user.id],
    );
    if (existing.rows.length === 0) {
      await run(
        "INSERT INTO reactions (post_id, user_id, kind, created_at) VALUES (?, ?, 'like', ?)",
        [post.id, viewer.user.id, now()],
      );
      await services.registry.bus.emit('reaction:added', {
        postId: post.id,
        userId: viewer.user.id,
        kind: 'like',
      });
    }
    if (post.userId) await recountUser(post.userId);

    const topic = await topicById(post.topicId, true);
    return c.redirect(topic ? `/t/${topic.slug}-${topic.id}/p/${post.id}#p${post.id}` : '/', 303);
  });

  app.post('/t/:handle/subscribe', async (c) => {
    const viewer = c.get('viewer');
    if (!viewer.user) return c.redirect('/login', 302);
    const topic = await topicById(topicIdFromHandle(c.req.param('handle')));
    if (!topic) return c.notFound();
    const form = await c.req.parseBody();
    await setSubscribed(viewer.user.id, topic.id, String(form.on ?? '1') === '1');
    await audit({ userId: viewer.user.id, action: 'topic.subscribe', targetType: 'topic', targetId: topic.id });
    return c.redirect(`/t/${topic.slug}-${topic.id}`, 303);
  });

  return app;
}

function pickFormat(value: unknown, settings: Settings): BodyFormat {
  const requested = String(value ?? settings['posts.defaultFormat'] ?? 'markdown');
  return requested === 'bbcode' ? 'bbcode' : 'markdown';
}

interface ComposerOptions {
  action: string;
  heading: string;
  withTitle: boolean;
  settings: Settings;
  submit: string;
  cancelHref: string;
  title?: string;
  body?: string;
  replyTo?: number;
  withReason?: boolean;
  error?: string;
  toolbar?: string;
}

function composerPage(
  _c: unknown,
  _services: Services,
  options: ComposerOptions,
) {
  const format = String(options.settings['posts.defaultFormat'] ?? 'markdown');
  return html`<div style="max-width:48rem">
    ${Card(html`
      ${CardHeader(options.heading)}
      ${CardContent(html`
        ${options.error ? Alert(options.error, { variant: 'destructive' }) : ''}
        <form method="post" action="${options.action}" class="composer">
          ${options.replyTo ? html`<input type="hidden" name="replyTo" value="${options.replyTo}" />` : ''}
          ${options.withTitle
            ? html`<div class="field">
                <label class="label" for="title">Title</label>
                <input class="input" id="title" name="title" required maxlength="160" value="${options.title ?? ''}" />
              </div>`
            : ''}
          ${options.toolbar ? html`<div class="composer-toolbar">${trusted(options.toolbar)}</div>` : ''}
          <label class="sr-only" for="body">Message</label>
          <textarea class="textarea mono" id="body" name="body" required rows="14"
            placeholder="Write your message. ${format === 'bbcode' ? 'BBCode' : 'Markdown'} is supported.">${options.body ?? ''}</textarea>
          ${options.withReason
            ? html`<div class="field" style="margin-top:.75rem">
                <label class="label" for="reason">Reason for editing (optional)</label>
                <input class="input" id="reason" name="reason" maxlength="120" />
              </div>`
            : ''}
          <div class="composer-actions">
            <div class="row">
              <label class="label" for="format" style="margin:0">Format</label>
              <select class="select" id="format" name="format" style="width:auto">
                <option value="markdown" ${format === 'markdown' ? 'selected' : ''}>Markdown</option>
                <option value="bbcode" ${format === 'bbcode' ? 'selected' : ''}>BBCode</option>
              </select>
            </div>
            <div class="row">
              ${LinkButton('Cancel', options.cancelHref, { variant: 'ghost' })}
              ${Button(options.submit, { type: 'submit' })}
            </div>
          </div>
        </form>
      `)}
    `)}
  </div>`;
}

async function composerError(
  c: Parameters<Parameters<Hono<AppEnv>['post']>[1]>[0],
  services: Services,
  error: unknown,
  options: Omit<ComposerOptions, 'settings'>,
) {
  const message =
    error instanceof PostError ? error.message : 'Something went wrong saving that. Try again.';
  if (!(error instanceof PostError)) console.error('[write]', error);
  return render(c as never, services, {
    title: options.heading,
    status: error instanceof PostError ? 400 : 500,
    body: composerPage(c, services, { ...options, settings: c.get('settings'), error: message }),
  });
}
