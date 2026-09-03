import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

const { hexToOklch, accentPair, brandCss } = await import('../packages/ui/src/styles/brand.ts');

describe('the board accent', () => {
  it('converts sRGB hex to OKLCh', () => {
    const white = hexToOklch('#ffffff');
    assert.ok(white);
    assert.ok(Math.abs(white.l - 1) < 0.001, 'white is lightness 1');
    assert.ok(white.c < 0.001, 'and has no chroma');

    const black = hexToOklch('#000000');
    assert.ok(black);
    assert.ok(black.l < 0.001);

    // A known landmark: sRGB green is a light, very saturated colour at ~148deg.
    const green = hexToOklch('#5fff87');
    assert.ok(green);
    assert.ok(green.l > 0.85, 'neon green is light');
    assert.ok(green.h > 140 && green.h < 160, 'and sits in the greens');

    assert.equal(hexToOklch('#5FFF87')?.h, green.h, 'case does not matter');
    assert.ok(
      Math.abs((hexToOklch('#0f0')?.l ?? 0) - (hexToOklch('#00ff00')?.l ?? 1)) < 1e-9,
      'three digits expand to six',
    );
    assert.ok(hexToOklch('5fff87'), 'the hash is optional');
  });

  it('refuses anything it cannot parse rather than guessing', () => {
    for (const bad of ['', 'green', '#12345', '#gggggg', 'rgb(1,2,3)']) {
      assert.equal(hexToOklch(bad), null, bad);
      assert.equal(brandCss(bad), '', `${bad} leaves the built-in palette alone`);
    }
    assert.equal(brandCss(undefined), '');
    assert.equal(brandCss(null), '');
  });

  it('gives a grey accent hue 0 rather than an accidental red', () => {
    // atan2(0, 0) is 0, not undefined — so a grey would come out red the moment
    // it was brightened for the dark theme if the chroma floor were missing.
    const grey = hexToOklch('#808080');
    assert.ok(grey);
    assert.equal(grey.h, 0);
    assert.ok(grey.c < 0.001);
    assert.ok(brandCss('#808080').includes('--primary: oklch('), 'a grey accent still applies');
  });

  it('darkens for light and brightens for dark, so one hex reads in both', () => {
    const neon = accentPair(hexToOklch('#5fff87')!);
    assert.ok(neon.light.l <= 0.62, 'unreadable on white until it is darkened');
    assert.ok(neon.dark.l >= 0.72, 'and stays bright on near-black');
    assert.equal(neon.light.h, neon.dark.h, 'the hue is what makes it the same brand');

    const deep = accentPair(hexToOklch('#1a237e')!);
    assert.ok(deep.dark.l >= 0.72, 'a very dark accent is lifted for the dark theme');

    const midway = hexToOklch('#4f46e5')!;
    const pair = accentPair(midway);
    assert.equal(pair.light.l, midway.l, 'an accent already in range is left exactly as chosen');
  });

  it('writes all three theme states, never a media query alone', () => {
    const css = brandCss('#5fff87');
    assert.ok(css.startsWith('/* Board accent: #5fff87 */'));
    assert.ok(/^:root \{/m.test(css), 'light lives on bare :root');
    assert.ok(css.includes('@media (prefers-color-scheme: dark)'), 'system dark is covered');
    assert.ok(css.includes(":root[data-theme='dark']"), 'and an explicit dark choice too');
    // Everything derived from the accent has to move with it, or a retheme
    // leaves orange glows around green buttons.
    for (const token of [
      '--ring',
      '--primary-hot',
      '--gradient-brand',
      '--glow-primary',
      '--page-wash',
      '--row-hover',
    ]) {
      assert.ok(css.includes(token), token);
    }
  });

  it('puts dark text on a bright accent and light text on a deep one', () => {
    const bright = brandCss('#5fff87');
    const deep = brandCss('#1a237e');
    const foregroundOf = (css: string) =>
      /--primary-foreground: oklch\(([0-9.]+)/.exec(
        css.slice(css.indexOf("[data-theme='dark']")),
      )?.[1];
    assert.ok(Number(foregroundOf(bright)) < 0.3, 'dark text on a neon button');
    assert.ok(
      Number(foregroundOf(deep)) < 0.3,
      'a deep accent is brightened for dark, so also dark text',
    );

    const lightSide = /--primary-foreground: oklch\(([0-9.]+)/.exec(deep)?.[1];
    assert.ok(Number(lightSide) > 0.9, 'white text on a deep accent in the light theme');
  });
});
