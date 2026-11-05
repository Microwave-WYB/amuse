/**
 * Pictures in the chat: which they are, the copies the server makes of each for the page (GET /files/<id>?w=,
 * api/src/images.ts), how large one alone in a message is drawn, and its placeholder (a ThumbHash kept with the
 * attachment, drawn blurred until the picture itself has been decoded). The image viewer (PhotoViewer.tsx) moves
 * between a chat's pictures and zooms into the original.
 */
import { type Attachment, type Entity, PREVIEW_WIDTHS } from "@amuse/protocol";
import { thumbHashToAverageRGBA, thumbHashToDataURL } from "thumbhash";

/** Kinds drawn in the page (as api/src/workspace.ts serves them inline). */
export const isPicture = (type: string) => /^image\/(png|jpeg|gif|webp|avif)$/.test(type);
/** Kinds the server scales down (a GIF is not: it may move). */
const scalable = (type: string) => /^image\/(png|jpeg|webp|avif)$/.test(type);

/** The pictures in a chat, in its order: the ones the viewer moves between. */
export function pictures(entities: readonly Entity[]): Attachment[] {
  return entities.flatMap((e) => (e.kind === "prompt" || e.kind === "reply" ? e.attachments.filter((a) => isPicture(a.type)) : []));
}

export interface Source {
  src: string;
  width: number;
  height: number;
}

/**
 * The scaled copies of a picture there are, smallest first, with the size each comes in: one for each width the server
 * offers, up to the first as wide as the picture (never wider: it is not enlarged). None for a picture of unknown size,
 * or one that is not scaled.
 */
export function copies(file: Attachment, url: (width: number) => string): Source[] {
  const { image } = file;
  if (!image || !scalable(file.type)) return [];
  const found: Source[] = [];
  for (const w of PREVIEW_WIDTHS) {
    const width = Math.min(w, image.width);
    found.push({ src: url(w), width, height: Math.round((image.height * width) / image.width) });
    if (w >= image.width) break;
  }
  return found;
}

/** For `<img srcset>`. */
export const srcSet = (sources: readonly Source[]) => sources.map((s) => `${s.src} ${s.width}w`).join(", ");

/** How large (CSS px) a picture alone in a message is drawn: its own size, at most `height` high (and the width there is). */
export function fitted(image: { width: number; height: number }, height: number): { width: number; height: number } {
  const scale = Math.min(1, height / image.height);
  return { width: Math.round(image.width * scale), height: Math.round(image.height * scale) };
}

/**
 * A picture in the image viewer: the copies it starts from, so a phone does not fetch a camera's megabytes to show a
 * picture the width of its screen, and its original, what zooming in comes to. A picture no wider than the widest copy
 * has a copy of its own full size (a screenshot's PNG is several times larger, for the same pixels): that one stands for
 * the original.
 */
export function slide(file: Attachment, original: string, url: (width: number) => string) {
  const { image } = file;
  if (!image) return { src: original, alt: file.name };
  const scaled = copies(file, url);
  const full = scaled.at(-1)?.width === image.width;
  return {
    src: original,
    alt: file.name,
    width: image.width,
    height: image.height,
    srcSet: full ? scaled : [...scaled, { src: original, width: image.width, height: image.height }],
  };
}

const drawnHashes = new Map<string, string | null>();
/** A ThumbHash (base64) drawn as a small PNG, to stretch blurred over the picture's place; null when it is not one. */
export function placeholder(hash: string): string | null {
  let url = drawnHashes.get(hash);
  if (url === undefined) {
    try {
      url = thumbHashToDataURL(Uint8Array.from(atob(hash), (c) => c.charCodeAt(0)));
    } catch {
      url = null;
    }
    drawnHashes.set(hash, url);
  }
  return url;
}

/** Whether a ThumbHash is of a picture with see-through parts (whose placeholder would show through it). */
export function seeThrough(hash: string): boolean {
  try {
    return thumbHashToAverageRGBA(Uint8Array.from(atob(hash), (c) => c.charCodeAt(0))).a < 1;
  } catch {
    return true;
  }
}

/** The copy of each picture the chat has drawn (by attachment id): the viewer starts from it, already decoded. */
export const drawn = new Map<string, string>();
