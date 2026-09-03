/*
 * Board branding: one accent colour in, a complete set of derived tokens out.
 *
 * The accent is stored as a hex value because that is what a colour input
 * gives an administrator, but every token the board reads is oklch — so the
 * conversion happens here, once, and the rest of the CSS never sees a hex.
 *
 * Deriving rather than storing matters for one reason: an accent that is
 * legible on a dark board is usually illegible on a light one. A neon green
 * reads beautifully on near-black and vanishes on white. So the same hue is
 * emitted at two different lightnesses — darkened for the light theme,
 * brightened for the dark one — and the board stays readable whichever theme
 * the reader picked, from a single setting.
 */

export interface Oklch {
  /** Perceptual lightness, 0-1. */
  l: number;
  /** Chroma. 0 is grey; ~0.25 is about as saturated as sRGB gets. */
  c: number;
  /** Hue in degrees, 0-360. */
  h: number;
}

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** sRGB 0-1 to linear-light. The 0.04045 knee is the sRGB transfer function. */
function toLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/**
 * `#rrggbb` (or `#rgb`) to OKLCh, using Björn Ottosson's matrices.
 *
 * Returns null rather than throwing or guessing: an unparseable accent means
 * the board falls back to its built-in palette, which is always better than
 * rendering with a colour nobody chose.
 */
export function hexToOklch(hex: string): Oklch | null {
  const match = HEX.exec(hex.trim());
  if (!match?.[1]) return null;

  const digits =
    match[1].length === 3
      ? match[1]
          .split('')
          .map((d) => d + d)
          .join('')
      : match[1];
  const int = Number.parseInt(digits, 16);

  const r = toLinear(((int >> 16) & 0xff) / 255);
  const g = toLinear(((int >> 8) & 0xff) / 255);
  const b = toLinear((int & 0xff) / 255);

  const lCone = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const mCone = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const sCone = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  const l = 0.2104542553 * lCone + 0.793617785 * mCone - 0.0040720468 * sCone;
  const a = 1.9779984951 * lCone - 2.428592205 * mCone + 0.4505937099 * sCone;
  const bAxis = 0.0259040371 * lCone + 0.7827717662 * mCone - 0.808675766 * sCone;

  const chroma = Math.hypot(a, bAxis);
  // A grey has no meaningful hue, and atan2(0, 0) is 0 rather than undefined —
  // which would silently make every grey accent red once it is brightened.
  const hue = chroma < 1e-6 ? 0 : ((Math.atan2(bAxis, a) * 180) / Math.PI + 360) % 360;

  return { l, c: chroma, h: hue };
}

const round = (value: number, places: number): number => Number(value.toFixed(places));

function oklch({ l, c, h }: Oklch, alpha?: number): string {
  const base = `${round(l, 4)} ${round(c, 4)} ${round(h, 2)}`;
  return alpha === undefined ? `oklch(${base})` : `oklch(${base} / ${alpha})`;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * The accent as it should appear on a light board and on a dark one.
 *
 * The ceiling and floor are contrast, not taste. Below ~0.62 lightness a
 * colour holds up as link text on white; above ~0.72 it holds up on near
 * black. An accent already inside a range is left exactly as it was chosen.
 */
export function accentPair(accent: Oklch): { light: Oklch; dark: Oklch } {
  const c = clamp(accent.c, 0, 0.25);
  return {
    light: { l: clamp(accent.l, 0.3, 0.62), c, h: accent.h },
    dark: { l: clamp(accent.l, 0.72, 0.9), c, h: accent.h },
  };
}

/** Text that sits ON the accent: dark on a bright accent, white on a deep one. */
function onAccent(colour: Oklch): string {
  return colour.l > 0.62
    ? oklch({ l: 0.16, c: Math.min(colour.c * 0.2, 0.04), h: colour.h })
    : oklch({ l: 0.985, c: 0, h: 0 });
}

/** Every token that follows the accent, for one theme. */
function accentTokens(colour: Oklch): string {
  const hot: Oklch = { l: clamp(colour.l + 0.06, 0, 0.95), c: colour.c, h: (colour.h + 18) % 360 };
  const foreground = onAccent(colour);

  return [
    `  --primary: ${oklch(colour)};`,
    `  --primary-foreground: ${foreground};`,
    `  --ring: ${oklch(colour)};`,
    `  --sidebar-primary: ${oklch(colour)};`,
    `  --sidebar-primary-foreground: ${foreground};`,
    `  --sidebar-ring: ${oklch(colour)};`,
    `  --unread: var(--primary);`,
    `  --primary-hot: ${oklch(hot)};`,
    `  --gradient-brand: linear-gradient(135deg, var(--primary) 0%, var(--primary-hot) 100%);`,
    `  --glow-primary: 0 0 0 1px ${oklch(colour, 0.28)}, 0 6px 20px -6px ${oklch(colour, 0.45)};`,
    `  --page-wash:`,
    `    radial-gradient(1100px 460px at 12% -8%, ${oklch(colour, 0.07)}, transparent 60%),`,
    `    radial-gradient(900px 400px at 92% -4%, ${oklch(hot, 0.06)}, transparent 62%);`,
    `  --row-hover: ${oklch(colour, 0.05)};`,
  ].join('\n');
}

/**
 * The stylesheet tail that applies a board's accent.
 *
 * Written for all three theme states, exactly as tokens.css is: bare `:root`
 * carries light, the media query carries the system default, and the
 * `[data-theme]` rule carries an explicit choice. A colour defined only inside
 * a media query is a colour that disappears when someone picks the other
 * theme.
 *
 * Returns '' for an unset or unparseable accent, which leaves the board's
 * built-in palette untouched.
 */
export function brandCss(accent: string | undefined | null): string {
  if (!accent) return '';
  const parsed = hexToOklch(accent);
  if (!parsed) return '';

  const { light, dark } = accentPair(parsed);
  return [
    `/* Board accent: ${accent} */`,
    `:root {`,
    accentTokens(light),
    `}`,
    ``,
    `@media (prefers-color-scheme: dark) {`,
    `  :root:not([data-theme='light']) {`,
    accentTokens(dark)
      .split('\n')
      .map((line) => (line ? `  ${line}` : line))
      .join('\n'),
    `  }`,
    `}`,
    ``,
    `:root[data-theme='dark'] {`,
    accentTokens(dark),
    `}`,
    ``,
  ].join('\n');
}
