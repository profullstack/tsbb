import { escapeHtml } from '@tsbb/markup';

/**
 * Email templates.
 *
 * Inline styles and a plain structure, because email clients strip <style>
 * blocks, ignore custom properties and have no dark-mode tokens. This is the
 * one place in the codebase that deliberately does not use the design system:
 * the design system targets browsers, and these do not run in one.
 *
 * Every template returns both html and text. A text part is not a courtesy —
 * without one, a message is far more likely to be scored as spam.
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const INK = '#18181b';
const MUTED = '#71717a';
const BORDER = '#e4e4e7';
const ACCENT = '#4f46e5';

function shell(boardName: string, body: string, footer: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:24px 12px;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${INK}">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;margin:0 auto">
<tr><td style="padding:0 0 16px;font-weight:700;font-size:15px;color:${INK}">${escapeHtml(boardName)}</td></tr>
<tr><td style="background:#ffffff;border:1px solid ${BORDER};border-radius:10px;padding:24px">${body}</td></tr>
<tr><td style="padding:16px 4px;font-size:12px;line-height:1.5;color:${MUTED}">${footer}</td></tr>
</table></body></html>`;
}

function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0">
<tr><td style="background:${ACCENT};border-radius:6px">
<a href="${escapeHtml(href)}" style="display:inline-block;padding:11px 22px;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none">${escapeHtml(label)}</a>
</td></tr></table>`;
}

export function magicLinkEmail(input: {
  boardName: string;
  url: string;
  minutes: number;
  isNew: boolean;
}): RenderedEmail {
  const heading = input.isNew ? 'Confirm your email to finish signing up' : 'Your sign-in link';
  const body =
    `<h1 style="margin:0 0 8px;font-size:18px;font-weight:650">${escapeHtml(heading)}</h1>` +
    `<p style="margin:0 0 4px;font-size:14px;line-height:1.6;color:${MUTED}">` +
    `Click the button below to sign in to ${escapeHtml(input.boardName)}. ` +
    `The link works once and expires in ${input.minutes} minutes.</p>` +
    button(input.url, 'Sign in') +
    `<p style="margin:0;font-size:12px;line-height:1.6;color:${MUTED};word-break:break-all">` +
    `Or paste this into your browser:<br>${escapeHtml(input.url)}</p>`;

  return {
    subject: `${input.isNew ? 'Confirm your email' : 'Sign in'} · ${input.boardName}`,
    html: shell(
      input.boardName,
      body,
      // Said plainly, because a sign-in email is exactly what a phishing attempt
      // imitates, and "you can ignore this" is the honest instruction.
      'If you did not ask to sign in, you can ignore this email — nothing will happen and your address stays unused.',
    ),
    text:
      `${heading}\n\nSign in to ${input.boardName}:\n${input.url}\n\n` +
      `This link works once and expires in ${input.minutes} minutes.\n` +
      `If you did not ask to sign in, ignore this email.`,
  };
}

export interface NotificationLine {
  title: string;
  excerpt: string | null;
  url: string;
  kind: string;
  actor: string | null;
}

const KIND_VERB: Record<string, string> = {
  reply: 'replied in',
  mention: 'mentioned you in',
  quote: 'replied to your post in',
  reaction: 'reacted to your post in',
  pm: 'sent you a message',
  solved: 'marked your answer as the solution in',
  moderation: 'moderation notice for',
};

function describe(line: NotificationLine): string {
  const verb = KIND_VERB[line.kind] ?? 'updated';
  return `${line.actor ?? 'Someone'} ${verb} ${line.title}`;
}

export function notificationEmail(input: {
  boardName: string;
  baseUrl: string;
  username: string;
  lines: NotificationLine[];
  unsubscribeUrl: string;
}): RenderedEmail {
  const single = input.lines.length === 1;
  const first = input.lines[0];
  const heading = single && first ? describe(first) : `${input.lines.length} new notifications`;

  const items = input.lines
    .map((line) => {
      const href = new URL(line.url, input.baseUrl).toString();
      return (
        `<tr><td style="padding:12px 0;border-bottom:1px solid ${BORDER}">` +
        `<a href="${escapeHtml(href)}" style="font-size:14px;font-weight:600;color:${INK};text-decoration:none">${escapeHtml(describe(line))}</a>` +
        (line.excerpt
          ? `<div style="margin-top:4px;font-size:13px;line-height:1.5;color:${MUTED}">${escapeHtml(line.excerpt)}</div>`
          : '') +
        `</td></tr>`
      );
    })
    .join('');

  const body =
    `<h1 style="margin:0 0 12px;font-size:18px;font-weight:650">${escapeHtml(single ? 'New activity' : heading)}</h1>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${items}</table>` +
    (single && first ? button(new URL(first.url, input.baseUrl).toString(), 'Read it') : '');

  return {
    subject: single && first ? describe(first) : `${input.lines.length} new notifications · ${input.boardName}`,
    html: shell(
      input.boardName,
      body,
      `You are getting this because you follow this activity on ${escapeHtml(input.boardName)}. ` +
        `<a href="${escapeHtml(input.unsubscribeUrl)}" style="color:${MUTED}">Change what you are emailed about</a>.`,
    ),
    text:
      `${heading}\n\n` +
      input.lines
        .map((l) => `- ${describe(l)}\n  ${new URL(l.url, input.baseUrl).toString()}`)
        .join('\n') +
      `\n\nChange what you are emailed about: ${input.unsubscribeUrl}`,
  };
}

export function welcomeEmail(input: {
  boardName: string;
  baseUrl: string;
  username: string;
}): RenderedEmail {
  const body =
    `<h1 style="margin:0 0 8px;font-size:18px;font-weight:650">Welcome to ${escapeHtml(input.boardName)}</h1>` +
    `<p style="margin:0;font-size:14px;line-height:1.6;color:${MUTED}">` +
    `You are signed in as <strong style="color:${INK}">${escapeHtml(input.username)}</strong>. ` +
    `Your username and picture can be changed in settings at any time.</p>` +
    button(new URL('/settings', input.baseUrl).toString(), 'Set up your profile');

  return {
    subject: `Welcome to ${input.boardName}`,
    html: shell(input.boardName, body, `You received this because an account was created for this address.`),
    text: `Welcome to ${input.boardName}.\n\nYou are signed in as ${input.username}.\nSet up your profile: ${new URL('/settings', input.baseUrl).toString()}`,
  };
}
