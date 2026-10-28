/**
 * A picture sent in the chat. Its place is kept at its size from the start (the attachment's `image`), with its
 * ThumbHash stretched over it, blurred; the picture fades in over that only once it has come whole and been decoded,
 * so it never paints line by line. The page fetches a copy scaled for where it is drawn (photos.ts), never the
 * original. A tap opens it in the image viewer.
 */
import { useLayoutEffect, useRef, useState } from "react";
import type { Attachment } from "@amuse/protocol";
import { useFiles } from "../files.ts";
import { useT } from "../i18n/react.ts";
import { copies, drawn, fitted, placeholder, srcSet } from "../photos.ts";

/** How high (CSS px) a picture alone in a message is drawn at most. */
const ALONE_HEIGHT = 360;
/** A picture among others: a square this large (CSS px), filled. */
const TILE = 144;
/** The width a picture of unknown size is fetched at. */
const UNKNOWN_WIDTH = 960;

export function Picture({
  file,
  single,
  onOpen,
  onGone,
}: {
  file: Attachment;
  /** alone in its message (drawn whole), or one of several (a square tile) */
  single: boolean;
  onOpen: () => void;
  /** its file is gone from the workspace */
  onGone: () => void;
}) {
  const t = useT();
  const files = useFiles();
  const img = useRef<HTMLImageElement>(null);
  const [ready, setReady] = useState(false);
  const { image } = file;
  const sources = files ? copies(file, (w) => files.preview(file.id, w)) : [];
  // a picture of unknown size (sent before sizes were kept) is fetched at one width; a GIF as it is
  const src = !files
    ? undefined
    : (sources.at(-1)?.src ?? (/^image\/gif$/.test(file.type) ? files.url(file.id) : files.preview(file.id, UNKNOWN_WIDTH)));
  const box = single ? (image ? fitted(image, ALONE_HEIGHT) : null) : { width: TILE, height: TILE };
  const blurred = image ? placeholder(image.placeholder) : null;

  /** shown once decoded whole: never half a picture */
  const decoded = () => {
    const el = img.current;
    if (!el) return;
    void el
      .decode()
      .catch(() => {})
      .then(() => {
        if (!el.isConnected) return;
        drawn.set(file.id, el.currentSrc);
        setReady(true);
      });
  };
  // one the browser already has may have loaded before React listened
  useLayoutEffect(() => {
    if (img.current?.complete && img.current.naturalWidth > 0) decoded();
  }, []);

  return (
    <button
      type="button"
      aria-label={t.photos.open(file.name)}
      onClick={onOpen}
      className={`relative block max-w-full overflow-hidden rounded-[18px] ${box ? "" : ready ? "" : "min-h-[120px] min-w-[160px]"}`}
      style={{
        background: "var(--fill-secondary)",
        ...(blurred ? { backgroundImage: `url(${blurred})`, backgroundSize: "cover", backgroundPosition: "center" } : {}),
        ...(box ? { width: box.width, aspectRatio: single && image ? `${image.width} / ${image.height}` : "1 / 1" } : {}),
      }}
    >
      <img
        ref={img}
        src={src}
        srcSet={sources.length > 0 ? srcSet(sources) : undefined}
        // a message takes at most 88% of the chat's width (ChatFeed's Sent)
        sizes={box ? `min(${box.width}px, 88vw)` : undefined}
        alt={file.name}
        loading="lazy"
        decoding="async"
        draggable={false}
        onLoad={decoded}
        onError={onGone}
        className={`block transition-opacity duration-300 ease-out ${ready ? "opacity-100" : "opacity-0"} ${box ? "size-full object-cover" : "max-h-[360px] max-w-full"}`}
      />
    </button>
  );
}
