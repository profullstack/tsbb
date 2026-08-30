import { createHash } from 'node:crypto';
import type { User } from '@tsbb/plugin-api';
import { escapeAttr } from '@tsbb/markup';

/**
 * Every user has an avatar, always. A board where half the posts show a broken
 * image or a grey blank reads as abandoned, so the fallback is a generated
 * identicon rather than a placeholder — deterministic from the username, so it
 * is stable across devices and needs no storage.
 */

export type AvatarSource =
  | { kind: 'url'; url: string }
  | { kind: 'identicon'; svg: string };

const PALETTE = [
  ['#4f46e5', '#c7d2fe'],
  ['#0891b2', '#a5f3fc'],
  ['#059669', '#a7f3d0'],
  ['#ca8a04', '#fef08a'],
  ['#dc2626', '#fecaca'],
  ['#9333ea', '#e9d5ff'],
  ['#db2777', '#fbcfe8'],
  ['#475569', '#cbd5e1'],
];

export function gravatarUrl(email: string, size = 128): string {
  // Gravatar still keys on MD5. It is not being used as a security primitive
  // here — it is the identifier their API takes.
  const hash = createHash('md5').update(email.trim().toLowerCase()).digest('hex');
  return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=404`;
}

/**
 * A 5x5 mirrored identicon, drawn as SVG so it costs no request and scales to
 * any size. The grid is mirrored about the vertical axis, which is what makes
 * an arbitrary hash look deliberate rather than like noise.
 */
export function identiconSvg(seed: string, size = 128): string {
  const hash = createHash('sha256').update(seed.toLowerCase()).digest();
  const [fg = '#4f46e5', bg = '#c7d2fe'] = PALETTE[(hash[0] ?? 0) % PALETTE.length] ?? [];
  const cells: string[] = [];
  const unit = 100 / 5;

  for (let x = 0; x < 3; x += 1) {
    for (let y = 0; y < 5; y += 1) {
      const bit = hash[x * 5 + y + 1] ?? 0;
      if (bit % 2 !== 0) continue;
      const rect = (col: number) =>
        `<rect x="${(col * unit).toFixed(2)}" y="${(y * unit).toFixed(2)}" width="${unit.toFixed(2)}" height="${unit.toFixed(2)}"/>`;
      cells.push(rect(x));
      if (x < 2) cells.push(rect(4 - x));
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}" role="img" aria-label="avatar">` +
    `<rect width="100" height="100" fill="${bg}" rx="12"/>` +
    `<g fill="${fg}">${cells.join('')}</g>` +
    `</svg>`
  );
}

export function avatarFor(
  user: Pick<User, 'id' | 'username' | 'email' | 'avatarKind' | 'avatarUrl'>,
  size = 64,
): AvatarSource {
  switch (user.avatarKind) {
    case 'upload':
      if (user.avatarUrl) return { kind: 'url', url: user.avatarUrl };
      break;
    case 'gravatar':
      return { kind: 'url', url: gravatarUrl(user.email, size) };
    case 'none':
      break;
    default:
      break;
  }
  return { kind: 'identicon', svg: identiconSvg(user.username, size) };
}

/**
 * A data: URI, so an identicon can be used anywhere a URL is required — an
 * <img src>, an email, the OpenGraph tag — without a route to serve it.
 */
export function identiconDataUri(seed: string, size = 128): string {
  return `data:image/svg+xml;base64,${Buffer.from(identiconSvg(seed, size)).toString('base64')}`;
}

export function avatarUrlFor(
  user: Pick<User, 'id' | 'username' | 'email' | 'avatarKind' | 'avatarUrl'>,
  size = 64,
): string {
  const source = avatarFor(user, size);
  return source.kind === 'url' ? escapeAttr(source.url) : identiconDataUri(user.username, size);
}
