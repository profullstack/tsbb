import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { formatBytes, ImageError, normaliseAvatar } from '../packages/core/src/images.ts';

/**
 * An avatar is displayed at 80px at the very largest, so anything bigger than
 * the stored size is a cost every reader pays on every page. These assert that
 * the crunch actually happens and that it cannot be skipped.
 */
describe('avatar crunching', () => {
  it('turns a multi-megabyte photo into a few kilobytes', async () => {
    // Random noise does not compress, so this is close to a worst case — a real
    // photograph will always do better than this.
    const raw = Buffer.alloc(2000 * 2000 * 3);
    for (let i = 0; i < raw.length; i += 1) raw[i] = Math.random() * 255;
    const photo = await sharp(raw, { raw: { width: 2000, height: 2000, channels: 3 } })
      .jpeg({ quality: 95 })
      .toBuffer();

    assert.ok(photo.length > 1_000_000, 'the fixture really is large');

    const started = Date.now();
    const out = await normaliseAvatar(photo);
    const elapsed = Date.now() - started;

    assert.equal(out.width, 256);
    assert.equal(out.height, 256);
    assert.equal(out.mime, 'image/webp');
    assert.ok(out.bytes.length < 60_000, `stored ${out.bytes.length} bytes`);
    assert.ok(out.bytes.length < photo.length / 20, 'at least 20x smaller');
    // Uploading is a foreground request; a slow crunch is a slow page.
    assert.ok(elapsed < 3000, `took ${elapsed}ms`);
  });

  it('applies EXIF orientation before cropping', async () => {
    // Orientation 6 means "rotate 90° clockwise to display". The pixels are
    // landscape and only the tag says otherwise, so without .rotate() every
    // portrait phone photo is stored on its side.
    const tall = await sharp({
      create: { width: 400, height: 800, channels: 3, background: { r: 20, g: 200, b: 120 } },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

    const out = await normaliseAvatar(tall);
    const meta = await sharp(out.bytes).metadata();
    assert.equal(meta.width, 256);
    assert.equal(meta.height, 256);
    assert.equal(meta.orientation, undefined, 'the tag is resolved, not carried forward');
  });

  it('strips metadata, because an avatar is the most public thing on a forum', async () => {
    const tagged = await sharp({
      create: { width: 600, height: 600, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .withMetadata({ exif: { IFD0: { Artist: 'anthony', Copyright: 'private' } } })
      .jpeg()
      .toBuffer();

    const out = await normaliseAvatar(tagged);
    const meta = await sharp(out.bytes).metadata();
    assert.ok(!meta.exif, 'EXIF (which on a phone photo includes GPS) is gone');
  });

  it('keeps transparency', async () => {
    const png = await sharp({
      create: { width: 800, height: 800, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const meta = await sharp((await normaliseAvatar(png)).bytes).metadata();
    assert.equal(meta.hasAlpha, true);
  });

  it('enlarges a tiny image rather than leaving it small', async () => {
    // Otherwise a 16px upload is stored at 16px and looks broken at 80px.
    const tiny = await sharp({
      create: { width: 16, height: 16, channels: 3, background: { r: 9, g: 9, b: 9 } },
    })
      .png()
      .toBuffer();
    const out = await normaliseAvatar(tiny);
    assert.equal(out.width, 256);
  });

  it('refuses anything that is not an image', async () => {
    for (const junk of [Buffer.from('<?php echo 1; ?>'), Buffer.alloc(0), Buffer.from('GIF89a-but-not-really')]) {
      await assert.rejects(() => normaliseAvatar(junk), (e: unknown) => e instanceof ImageError);
    }
  });

  it('formats sizes the way a person reads them', () => {
    assert.equal(formatBytes(900), '900B');
    assert.equal(formatBytes(2_083_000), '2.0MB');
    assert.equal(formatBytes(12_800), '13KB');
  });
});
