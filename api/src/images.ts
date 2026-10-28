/**
 * Pictures sent in the chat. When one is sent, the server reads its size and makes a ThumbHash of it (the
 * Attachment's `image`), so the page can lay it out and draw it blurred at once. The page shows a smaller copy
 * (WebP, at one of PREVIEW_WIDTHS) instead of the original, which a phone's camera makes several megabytes and
 * a baseline JPEG that paints line by line; the original stays for the image viewer. Both are made with sharp
 * (libvips), and the copies are kept for a while in memory.
 */
import type { Attachment } from "@amuse/protocol";
import sharp from "sharp";
import { rgbaToThumbHash } from "thumbhash";

// no file is held open after it is read (an upload is renamed into the workspace right after)
sharp.cache({ files: 0 });

/** Pictures the server reads. A GIF is read for its size, but never scaled: it may move. */
const readable = (type: string) => /^image\/(png|jpeg|gif|webp|avif)$/.test(type);
/** Pictures scaled down for the page. */
export const scalable = (type: string) => /^image\/(png|jpeg|webp|avif)$/.test(type);

/** A ThumbHash is made from the picture at most this large (its algorithm's limit). */
const HASH_SIZE = 100;
/** WebP quality for the copies: 80 is where the copies stop looking any better on a phone. */
const QUALITY = 80;

/** A picture's size as shown and its ThumbHash, from its bytes or its file; undefined for anything else, or a picture that cannot be read. */
export async function describe(data: Uint8Array | string, type: string): Promise<Attachment["image"]> {
  if (!readable(type)) return undefined;
  try {
    // turned upright by its EXIF orientation, as a browser shows it
    const { data: rgba, info } = await sharp(data)
      .autoOrient()
      .resize(HASH_SIZE, HASH_SIZE, { fit: "inside" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { autoOrient } = await sharp(data).metadata();
    return {
      width: autoOrient.width,
      height: autoOrient.height,
      placeholder: Buffer.from(rgbaToThumbHash(info.width, info.height, rgba)).toString("base64"),
    };
  } catch {
    return undefined;
  }
}

/** The picture `width` px wide (never wider than it is), upright, as WebP. Throws when it cannot be read. */
export function scaled(data: Uint8Array, width: number): Promise<Buffer> {
  return sharp(data).autoOrient().resize({ width, withoutEnlargement: true }).webp({ quality: QUALITY }).toBuffer();
}

/**
 * The copies made, by key (the file, its state and the width), the most recently used kept up to `limit` bytes. A
 * copy asked for again while it is being made waits for that one.
 */
export function previews(limit = 48 * 1024 ** 2) {
  const kept = new Map<string, Buffer>();
  const making = new Map<string, Promise<Buffer>>();
  let bytes = 0;
  const keep = (key: string, copy: Buffer) => {
    if (copy.length > limit) return;
    kept.set(key, copy);
    bytes += copy.length;
    for (const [oldest, was] of kept) {
      if (bytes <= limit) break;
      kept.delete(oldest);
      bytes -= was.length;
    }
  };
  return {
    async get(key: string, make: () => Promise<Buffer>): Promise<Buffer> {
      const found = kept.get(key);
      if (found) {
        // used now: to the end of the line
        kept.delete(key);
        kept.set(key, found);
        return found;
      }
      const pending = making.get(key);
      if (pending) return pending;
      const made = make().then(
        (copy) => {
          making.delete(key);
          keep(key, copy);
          return copy;
        },
        (error: unknown) => {
          making.delete(key);
          throw error;
        },
      );
      making.set(key, made);
      return made;
    },
    get bytes() {
      return bytes;
    },
  };
}
