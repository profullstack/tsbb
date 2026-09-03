import { Hono } from 'hono';
import type { Context } from 'hono';
import { html } from 'hono/html';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  approveDeviceCode,
  consumeMagicLink,
  createSession,
  destroySession,
  magicLinkRateLimited,
  queueEmail,
  startMagicLink,
  userByEmail,
  userCount,
} from '@tsbb/core';
import { magicLinkEmail, welcomeEmail } from '@tsbb/mail';
import { Alert, Button, Card, CardContent, CardHeader } from '@tsbb/ui';
import { render, SESSION_COOKIE, THEME_COOKIE, type AppEnv, type Services } from '../context.ts';

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function cookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: 'Lax' as const,
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  };
}

export function authRoutes(services: Services) {
  const app = new Hono<AppEnv>();
  const secure = services.baseUrl.startsWith('https://');

  /**
   * One page for signing in and signing up, because they are one mechanism.
   * It is still *called* sign-up where a new visitor would look for it: a
   * mechanism with no name reads as "this site has no accounts".
   */
  app.get('/login', async (c) => authPage(c, services, { sent: false }));
  app.get('/signup', async (c) => authPage(c, services, { sent: false, isSignup: true }));

  app.post('/login', async (c) => {
    const form = await c.req.parseBody();
    const email = String(form.email ?? '').trim();
    const redirectTo = typeof form.redirect === 'string' ? form.redirect : null;

    /*
     * Every outcome below answers identically, and deliberately.
     *
     * A different response for a known address, an unknown one, or a rate-limited
     * one turns this endpoint into a way to ask "does this person have an
     * account here" — which on a forum about anything sensitive is a real
     * disclosure. Malformed input is the only thing that answers differently,
     * because that is about the request rather than the person.
     */
    if (!EMAIL_SHAPE.test(email)) {
      return authPage(c, services, { sent: false, error: 'That does not look like an email address.' });
    }

    if (!(await magicLinkRateLimited(email))) {
      const settings = c.get('settings');
      const existing = await userByEmail(email);
      const { token } = await startMagicLink({
        email,
        ip: clientIp(c),
        redirectTo: redirectTo && redirectTo.startsWith('/') ? redirectTo : null,
      });
      const url = new URL(`/auth/${token}`, services.baseUrl).toString();
      const message = magicLinkEmail({
        boardName: String(settings['board.name'] ?? 'tsbb'),
        url,
        minutes: 20,
        isNew: !existing,
      });
      await queueEmail({
        to: email,
        userId: existing?.id ?? null,
        subject: message.subject,
        html: message.html,
        text: message.text,
        kind: 'magic-link',
      });
    }

    return authPage(c, services, { sent: true, email });
  });

  app.get('/auth/:token', async (c) => {
    const result = await consumeMagicLink(c.req.param('token'));
    if (!result) {
      return authPage(c, services, {
        sent: false,
        error: 'That link has expired or has already been used. Ask for a new one.',
      });
    }

    const isFirstEver = (await userCount()) === 1 && result.user.isAdmin;
    const session = await createSession(result.user.id, {
      userAgent: c.req.header('user-agent'),
      ip: clientIp(c),
    });
    setCookie(c, SESSION_COOKIE, session.id, cookieOptions(secure));

    if (isFirstEver) {
      const settings = c.get('settings');
      const message = welcomeEmail({
        boardName: String(settings['board.name'] ?? 'tsbb'),
        baseUrl: services.baseUrl,
        username: result.user.username,
      });
      await queueEmail({
        to: result.user.email,
        userId: result.user.id,
        subject: message.subject,
        html: message.html,
        text: message.text,
        kind: 'welcome',
      });
    }

    await services.registry.bus.emit('user:login', { user: result.user, method: 'magic-link' });
    // Only a board-relative path is ever followed, so a crafted link cannot
    // bounce someone straight off the board after signing them in.
    const target = result.redirectTo?.startsWith('/') ? result.redirectTo : '/';
    return c.redirect(target, 302);
  });

  app.post('/logout', async (c) => {
    const sessionId = getCookie(c, SESSION_COOKIE);
    if (sessionId) await destroySession(sessionId);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.redirect('/', 302);
  });

  /** Theme is a cookie, so the server can put it in the markup before paint. */
  app.post('/prefs/theme', async (c) => {
    const form = await c.req.parseBody();
    const choice = String(form.theme ?? 'system');
    /*
     * All three choices are STORED, 'system' included. Deleting the cookie
     * instead would be the same thing only on a board whose own default is
     * 'system': on a board that defaults to dark, "follow the system" would
     * fall straight back to dark and the toggle would look broken.
     */
    if (choice === 'light' || choice === 'dark' || choice === 'system') {
      setCookie(c, THEME_COOKIE, choice, { path: '/', maxAge: 31_536_000, sameSite: 'Lax' });
    } else {
      deleteCookie(c, THEME_COOKIE, { path: '/' });
    }
    const back = c.req.header('referer');
    return c.redirect(back && back.startsWith(services.baseUrl) ? back : '/', 303);
  });

  // --- Device authorisation, for the terminal client ----------------------

  app.get('/link', async (c) => {
    const viewer = c.get('viewer');
    const code = c.req.query('code') ?? '';
    if (!viewer.user) {
      return c.redirect(`/login?redirect=${encodeURIComponent(`/link?code=${code}`)}`, 302);
    }
    return render(c, services, {
      title: 'Link a device',
      body: Card(html`${CardHeader('Link a device', {
        description: 'Approve the code shown in your terminal.',
      })}
      ${CardContent(html`<form method="post" action="/link">
        <div class="field">
          <label class="label" for="code">Code</label>
          <input class="input" id="code" name="code" value="${code}" autocomplete="off" autocapitalize="characters" required />
          <div class="field-hint">It looks like ABCD-EFGH and expires ten minutes after it appears.</div>
        </div>
        ${Button('Approve', { type: 'submit' })}
      </form>`)}`),
    });
  });

  app.post('/link', async (c) => {
    const viewer = c.get('viewer');
    if (!viewer.user) return c.redirect('/login', 302);
    const form = await c.req.parseBody();
    const ok = await approveDeviceCode(String(form.code ?? ''), viewer.user.id);
    return render(c, services, {
      title: ok ? 'Device linked' : 'Code not recognised',
      body: Card(
        CardContent(
          ok
            ? Alert('Your terminal is signed in. You can close this page.', {
                variant: 'success',
                title: 'Device linked',
              })
            : Alert('That code is wrong, already used, or has expired. Start again in your terminal.', {
                variant: 'destructive',
                title: 'Code not recognised',
              }),
        ),
      ),
    });
  });

  return app;
}

function clientIp(c: { req: { header: (name: string) => string | undefined } }): string | null {
  return (
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    null
  );
}

async function authPage(
  c: Context<AppEnv>,
  services: Services,
  state: { sent: boolean; email?: string; error?: string; isSignup?: boolean },
) {
  const heading = state.isSignup ? 'Create your account' : 'Sign in';
  const redirect = c.req.query('redirect') ?? '';

  const body = html`<div style="max-width:26rem;margin:2rem auto">
    ${Card(html`
      ${CardHeader(heading, {
        description: 'We email you a link. There is no password to choose or forget.',
      })}
      ${CardContent(
        state.sent
          ? Alert(
              html`If <strong>${state.email}</strong> can receive mail, a sign-in link is on its way.
                It works once and expires in twenty minutes.`,
              { variant: 'success', title: 'Check your inbox' },
            )
          : html`
              ${state.error ? Alert(state.error, { variant: 'destructive' }) : ''}
              <form method="post" action="/login">
                ${redirect ? html`<input type="hidden" name="redirect" value="${redirect}" />` : ''}
                <div class="field">
                  <label class="label" for="email">Email address</label>
                  <input
                    class="input"
                    id="email"
                    name="email"
                    type="email"
                    autocomplete="email"
                    required
                    placeholder="you@example.com"
                  />
                  <div class="field-hint">
                    New here? The same link creates your account — there is nothing else to fill in.
                  </div>
                </div>
                ${Button('Email me a link', { type: 'submit', class: 'btn-block' })}
              </form>
            `,
      )}
    `)}
  </div>`;

  return render(c, services, { title: heading, body });
}
