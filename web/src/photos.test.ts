import assert from "node:assert/strict";
import { test } from "node:test";
import type { Attachment, Entity } from "@amuse/protocol";
import { thumbHashToRGBA } from "thumbhash";
import { copies, fitted, pictures, placeholder, seeThrough, slide, srcSet } from "./photos.ts";

/** A ThumbHash of a plain landscape picture (made by the server's images.ts), and one with see-through parts. */
const HASH = "IosCBYCHh4h4iIePh4h4jXB3cKgI";
const SEE_THROUGH = "HMuCBIAFiIeHh3+Hh4gHh3d/d3h4CIeIAg==";

const file = (id: string, type: string, image?: Attachment["image"]): Attachment => ({
  id,
  name: `${id}.${type.split("/")[1]}`,
  type,
  size: 1000,
  path: `user/media_library/${id}`,
  ...(image ? { image } : {}),
});
const photo = file("f1", "image/jpeg", { width: 4000, height: 3000, placeholder: HASH });
const url = (w: number) => `/files/f1?w=${w}`;

test("a chat's pictures are those of its messages, in order; videos and other files are not", () => {
  const at = "2026-10-28T10:00:00Z";
  const entities: Entity[] = [
    { kind: "prompt", id: "p1", at, text: "", timezone: "UTC", attachments: [photo, file("v", "video/mp4"), file("d", "application/pdf")], quote: null, suggested: false },
    { kind: "reply", id: "r1", at, text: "here", streaming: false, attachments: [file("s", "image/png"), file("g", "image/gif")], suggestions: [], chosen: null },
    { kind: "failure", id: "x", at, message: "", detail: "", retry: null } as unknown as Entity,
  ];
  assert.deepEqual(pictures(entities).map((a) => a.id), ["f1", "s", "g"]);
});

test("a picture comes in a copy per width offered, up to its own: never enlarged", () => {
  assert.deepEqual(copies(photo, url), [
    { src: "/files/f1?w=480", width: 480, height: 360 },
    { src: "/files/f1?w=960", width: 960, height: 720 },
    { src: "/files/f1?w=1600", width: 1600, height: 1200 },
  ]);
  const small = file("f1", "image/png", { width: 700, height: 350, placeholder: HASH });
  assert.deepEqual(copies(small, url), [
    { src: "/files/f1?w=480", width: 480, height: 240 },
    { src: "/files/f1?w=960", width: 700, height: 350 },
  ]);
  assert.equal(srcSet(copies(small, url)), "/files/f1?w=480 480w, /files/f1?w=960 700w");
  assert.deepEqual(copies(file("g", "image/gif", { width: 300, height: 300, placeholder: HASH }), url), [], "a GIF is not scaled");
  assert.deepEqual(copies(file("old", "image/jpeg"), url), [], "nor one of unknown size");
});

test("a picture alone in a message is drawn at its own size, at most so high", () => {
  assert.deepEqual(fitted({ width: 4000, height: 3000 }, 360), { width: 480, height: 360 });
  assert.deepEqual(fitted({ width: 1080, height: 2400 }, 360), { width: 162, height: 360 });
  assert.deepEqual(fitted({ width: 200, height: 100 }, 360), { width: 200, height: 100 }, "never enlarged");
});

test("the viewer starts from the smaller copies and zooms into the original", () => {
  assert.deepEqual(slide(photo, "/files/f1", url), {
    src: "/files/f1",
    alt: "f1.jpeg",
    width: 4000,
    height: 3000,
    srcSet: [
      { src: "/files/f1?w=480", width: 480, height: 360 },
      { src: "/files/f1?w=960", width: 960, height: 720 },
      { src: "/files/f1?w=1600", width: 1600, height: 1200 },
      { src: "/files/f1", width: 4000, height: 3000 },
    ],
  });
  // a picture no wider than the widest copy is shown from its full-size copy, not a screenshot's heavy PNG
  const small = file("f1", "image/png", { width: 1080, height: 2400, placeholder: HASH });
  assert.deepEqual(slide(small, "/files/f1", url).srcSet, [
    { src: "/files/f1?w=480", width: 480, height: 1067 },
    { src: "/files/f1?w=960", width: 960, height: 2133 },
    { src: "/files/f1?w=1600", width: 1080, height: 2400 },
  ]);
  // a GIF is not scaled: its original only
  const gif = file("g", "image/gif", { width: 300, height: 200, placeholder: HASH });
  assert.deepEqual(slide(gif, "/files/g", url).srcSet, [{ src: "/files/g", width: 300, height: 200 }]);
  assert.deepEqual(slide(file("old", "image/jpeg"), "/files/old", url), { src: "/files/old", alt: "old.jpeg" });
});

test("a placeholder is the ThumbHash drawn as a small PNG; a broken one is none", () => {
  const drawn = placeholder(HASH);
  assert.match(drawn ?? "", /^data:image\/png;base64,/);
  assert.equal(placeholder(HASH), drawn, "drawn once");
  const { w, h } = thumbHashToRGBA(Uint8Array.from(atob(HASH), (c) => c.charCodeAt(0)));
  assert.ok(w > h, "landscape, as the picture");
  assert.equal(placeholder("not base64!"), null);
  assert.equal(seeThrough(HASH), false);
  assert.equal(seeThrough(SEE_THROUGH), true);
});
