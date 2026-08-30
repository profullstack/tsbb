import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** URL-safe slug. Never empty: a title of pure punctuation still gets an id. */
export function slugify(input: string, fallback = 'topic'): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72)
    .replace(/-+$/g, '');
  return slug || fallback;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** A short code a human can read out loud. Excludes look-alike characters. */
const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789';
export function humanCode(length = 8): string {
  const buffer = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET[(buffer[i] ?? 0) % CODE_ALPHABET.length];
    if (i === 3 && length > 4) out += '-';
  }
  return out;
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * IP addresses are only ever stored hashed with a per-install salt. Without the
 * salt the hash is reversible by enumeration — there are only four billion IPv4
 * addresses — so an unset salt is a real weakness, not a formality.
 */
export function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const salt = process.env.TSBB_IP_HASH_SALT ?? process.env.TSBB_SESSION_SECRET ?? '';
  if (!salt) return null;
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 32);
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Parse a positive integer from untrusted input, or fall back. */
export function toInt(value: unknown, fallback = 0): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function toBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'on' || value === 'true';
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "3 minutes ago" — computed server-side so it works with JavaScript off. */
export function relativeTime(from: number, now = Date.now()): string {
  const delta = now - from;
  if (delta < MINUTE) return 'just now';
  if (delta < HOUR) return plural(Math.floor(delta / MINUTE), 'minute');
  if (delta < DAY) return plural(Math.floor(delta / HOUR), 'hour');
  if (delta < 30 * DAY) return plural(Math.floor(delta / DAY), 'day');
  if (delta < 365 * DAY) return plural(Math.floor(delta / (30 * DAY)), 'month');
  return plural(Math.floor(delta / (365 * DAY)), 'year');
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
}

export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
}
