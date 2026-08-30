import sharp from 'sharp';
import type { Metadata, Sharp } from 'sharp';

/**
 * Avatar normalisation.
 *
 * An avatar is displayed at 80px at its very largest, so storing what came off
 * a phone is pure waste — waste that is paid on every page view by every
 * reader, forever. Uploads are therefore accepted generously and *crunched* on
 * the way in: one fixed size, one modern format, nothing else kept.
 *
 * Three things here are not optional:
 *
 * - `.rotate()` runs BEFORE the resize. It applies the EXIF orientation tag,
 *   and without it every photo taken in portrait on a phone arrives sideways —
 *   the image data is landscape and only the tag says otherwise.
 * - Metadata is dropped (sharp's default). A phone photo carries GPS
 *   coordinates, and an avatar is the most public thing on a forum.
 * - `limitInputPixels` is set. A few-kilobyte PNG can declare gigapixel
 *   dimensions and exhaust memory on decode; the byte-size check alone does
 *   not catch a decompression bomb.
 */

/** What the stored avatar is. Anything larger is a cost with no benefit. */
export const AVATAR_SIZE = 256;

/** Refuse to even decode beyond this. 40 megapixels is far past any camera crop. */
const MAX_INPUT_PIXELS = 40_000_000;

export interface NormalisedImage {
  bytes: Buffer;
  mime: string;
  width: number;
  height: number;
  /** What the upload weighed before crunching, for the confirmation message. */
  originalBytes: number;
}

export class ImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageError';
  }
}

export async function normaliseAvatar(
  input: Buffer,
  size: number = AVATAR_SIZE,
): Promise<NormalisedImage> {
  let pipeline: Sharp;
  try {
    pipeline = sharp(input, {
      limitInputPixels: MAX_INPUT_PIXELS,
      // Truncated or slightly malformed files are common from phones and are
      // worth salvaging; anything genuinely unreadable still throws below.
      failOn: 'error',
    });
  } catch {
    throw new ImageError('That file is not an image we can read.');
  }

  let meta: Metadata;
  try {
    meta = await pipeline.metadata();
  } catch {
    throw new ImageError('That file is not an image we can read.');
  }

  if (!meta.width || !meta.height) {
    throw new ImageError('That file is not an image we can read.');
  }

  try {
    const bytes = await pipeline
      // EXIF orientation first, or a portrait photo lands on its side.
      .rotate()
      .resize(size, size, {
        fit: 'cover',
        // Crop toward the busiest region rather than the geometric centre, so
        // an off-centre face survives the square crop.
        position: sharp.strategy.attention,
        withoutEnlargement: false,
      })
      // WebP at this size beats PNG and JPEG on both bytes and quality, keeps
      // transparency, and is supported everywhere that matters now.
      .webp({ quality: 82, effort: 4 })
      .toBuffer();

    return {
      bytes,
      mime: 'image/webp',
      width: size,
      height: size,
      originalBytes: input.length,
    };
  } catch (error) {
    const message = (error as Error).message ?? '';
    if (message.includes('pixel') || message.includes('limit')) {
      throw new ImageError('That image has too many pixels to process safely.');
    }
    throw new ImageError('We could not process that image. Try a PNG or JPEG.');
  }
}

/** Human-readable size, for messages people actually read. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
