/**
 * The image viewer: a picture sent in the chat, full screen over everything, and the chat's other pictures beside it.
 * yet-another-react-lightbox does the gestures: pinch, double tap and the wheel zoom (and a zoomed picture pans),
 * a swipe left or right goes to the next picture, a pull up or down closes it (the picture follows the finger and the
 * black behind it fades, index.css), and on a desktop the arrow keys move and Esc closes. Its own close goes back
 * through the UI state, so the phone's Back closes it too (back.ts).
 *
 * A picture starts from the copy the chat drew, or its ThumbHash, blurred, and the sharp copy fades in over that
 * once decoded; zooming in fetches larger copies, up to the original (photos.ts).
 */
import { useMemo, useRef } from "react";
import type { Attachment } from "@amuse/protocol";
import Lightbox, { type Slide } from "yet-another-react-lightbox";
import Counter from "yet-another-react-lightbox/plugins/counter";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import "yet-another-react-lightbox/styles.css";
import "yet-another-react-lightbox/plugins/counter.css";
import { useFiles } from "../files.ts";
import { useT } from "../i18n/react.ts";
import { drawn, placeholder, seeThrough, slide } from "../photos.ts";

/** Zoomed in as far as one pixel of the picture to this many of the screen's: past its own pixels, enough to read small print. */
const MAX_ZOOM_PIXELS = 2;

export default function PhotoViewer({
  pictures,
  open,
  onShow,
}: {
  /** the chat's pictures, in its order */
  pictures: Attachment[];
  /** the one shown (an attachment's id); null: closed */
  open: string | null;
  /** show another picture of the chat, or (null) close */
  onShow: (id: string | null) => void;
}) {
  const t = useT();
  const files = useFiles();
  const slides = useMemo(
    () =>
      files
        ? pictures.map((file): Slide & { file: Attachment } => ({
            ...slide(file, files.url(file.id), (w) => files.preview(file.id, w)),
            file,
          }))
        : [],
    [pictures, files],
  );
  const index = pictures.findIndex((p) => p.id === open);
  // the one shown last, kept while the viewer fades out
  const last = useRef(0);
  if (index >= 0) last.current = index;
  const touch = matchMedia("(hover: none)").matches;

  return (
    <Lightbox
      open={index >= 0}
      close={() => onShow(null)}
      index={last.current}
      slides={slides}
      plugins={[Zoom, Counter]}
      on={{
        view: ({ index: shown }) => {
          const id = pictures[shown]?.id;
          if (id && id !== open) onShow(id);
        },
      }}
      carousel={{ finite: true, padding: 0, spacing: "12%", preload: 1 }}
      controller={{ closeOnPullUp: true, closeOnPullDown: true, closeOnBackdropClick: true }}
      zoom={{ maxZoomPixelRatio: MAX_ZOOM_PIXELS, scrollToZoom: true }}
      animation={{ fade: 220, swipe: 320 }}
      counter={{ container: { style: { top: 0, left: 0 } } }}
      labels={{
        Previous: t.photos.previous,
        Next: t.photos.next,
        Close: t.photos.close,
        "Zoom in": t.photos.zoomIn,
        "Zoom out": t.photos.zoomOut,
        Lightbox: t.photos.viewer,
        Carousel: t.photos.pictures,
        "Photo gallery": t.photos.pictures,
        Slide: t.photos.picture,
        "{index} of {total}": t.photos.position,
      }}
      render={{
        // one picture has nothing to move to; a phone swipes, and pinches rather than tapping buttons to zoom
        ...(slides.length <= 1 || touch ? { buttonPrev: () => null, buttonNext: () => null } : {}),
        ...(touch ? { buttonZoom: () => null } : {}),
        slideContainer: ({ slide: shown, children }) => (
          <div className="relative isolate flex size-full items-center justify-center">
            <Underneath file={(shown as Slide & { file?: Attachment }).file} />
            {children}
          </div>
        ),
      }}
      className="photo-viewer"
    />
  );
}

/**
 * What a picture is drawn over until its sharp copy has been decoded: the copy the chat drew (decoded already) over
 * its ThumbHash, at exactly the place and size the picture will have (contained in the screen, never enlarged).
 * None for a picture with see-through parts, which would show it through.
 */
function Underneath({ file }: { file: Attachment | undefined }) {
  const image = file?.image;
  if (!file || !image || seeThrough(image.placeholder)) return null;
  const layers = [drawn.get(file.id), placeholder(image.placeholder)].filter((url) => url).map((url) => `url("${url}")`);
  return (
    <div className="pointer-events-none absolute inset-0 -z-10 flex items-center justify-center [container-type:size]">
      <div
        style={{
          width: `min(${image.width}px, 100cqw, ${image.width / image.height} * 100cqh)`,
          aspectRatio: `${image.width} / ${image.height}`,
          backgroundImage: layers.join(", "),
          backgroundSize: "100% 100%",
        }}
      />
    </div>
  );
}
