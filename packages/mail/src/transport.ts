import type { PendingEmail } from '@tsbb/core';

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface Transport {
  name: string;
  send(email: OutgoingEmail): Promise<void>;
}

/** Prints to stdout. The default, so a fresh install never silently drops mail. */
export function consoleTransport(): Transport {
  return {
    name: 'console',
    async send(email) {
      console.log(
        `\n--- mail (not sent: TSBB_MAIL_TRANSPORT is "console") ---\n` +
          `To: ${email.to}\nSubject: ${email.subject}\n\n${email.text}\n---\n`,
      );
    },
  };
}

export function resendTransport(apiKey: string, from: string): Transport {
  return {
    name: 'resend',
    async send(email) {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: [email.to],
          subject: email.subject,
          html: email.html,
          text: email.text,
        }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`resend ${response.status}: ${detail.slice(0, 300)}`);
      }
    },
  };
}

/**
 * SMTP through nodemailer, imported lazily.
 *
 * Lazy because nodemailer is an optional dependency: a board on Resend, or one
 * still on the console transport, should not have to install it — and an
 * install that lacks it should fail with a sentence explaining what to run,
 * not a module-not-found stack trace at boot.
 */
export function smtpTransport(url: string, from: string): Transport {
  return {
    name: 'smtp',
    async send(email) {
      let nodemailer: { createTransport: (u: string) => { sendMail: (o: unknown) => Promise<unknown> } };
      try {
        // The specifier goes through a variable so TypeScript does not try to
        // resolve a package that is deliberately optional. The import is
        // guarded and reports what to install if it is absent.
        const specifier = 'nodemailer';
        nodemailer = (await import(specifier)) as never;
      } catch {
        throw new Error(
          'TSBB_MAIL_TRANSPORT=smtp needs nodemailer. Run: pnpm add nodemailer',
        );
      }
      const transporter = nodemailer.createTransport(url);
      await transporter.sendMail({
        from,
        to: email.to,
        subject: email.subject,
        html: email.html,
        text: email.text,
      });
    },
  };
}

let cached: Transport | null = null;

export function transport(): Transport {
  if (cached) return cached;
  const kind = (process.env.TSBB_MAIL_TRANSPORT ?? 'console').toLowerCase();
  const from = process.env.TSBB_MAIL_FROM ?? 'board@localhost';

  if (kind === 'resend') {
    const key = process.env.RESEND_API_KEY?.trim();
    if (!key) {
      console.warn('[mail] TSBB_MAIL_TRANSPORT=resend but RESEND_API_KEY is unset; using console.');
      cached = consoleTransport();
      return cached;
    }
    cached = resendTransport(key, from);
    return cached;
  }

  if (kind === 'smtp') {
    const url = process.env.SMTP_URL?.trim();
    if (!url) {
      console.warn('[mail] TSBB_MAIL_TRANSPORT=smtp but SMTP_URL is unset; using console.');
      cached = consoleTransport();
      return cached;
    }
    cached = smtpTransport(url, from);
    return cached;
  }

  cached = consoleTransport();
  return cached;
}

export function setTransport(next: Transport | null): void {
  cached = next;
}

export type { PendingEmail };
