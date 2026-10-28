import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { thumbHashToAverageRGBA, thumbHashToRGBA } from "thumbhash";
import { describe, previews, scalable, scaled } from "./images.ts";

/** A picture of one colour, `width` × `height`, in a format. */
const picture = (width: number, height: number, format: "png" | "jpeg" | "gif" | "webp", colour = { r: 200, g: 40, b: 40 }) =>
  sharp({ create: { width, height, channels: 3, background: colour } })
    .toFormat(format)
    .toBuffer();

test("a picture is described by its size and a ThumbHash of it", async () => {
  const image = await describe(await picture(1200, 600, "png"), "image/png");
  assert.ok(image);
  assert.deepEqual({ width: image.width, height: image.height }, { width: 1200, height: 600 });
  const hash = Buffer.from(image.placeholder, "base64");
  assert.ok(hash.length < 40, "a few dozen bytes, kept with the attachment");
  const drawn = thumbHashToRGBA(hash);
  assert.ok(drawn.w > drawn.h, "drawn wider than high");
  const { r, g, b } = thumbHashToAverageRGBA(hash);
  assert.ok(r > 0.6 && g < 0.3 && b < 0.3, "its colour, roughly");
});

test("a photo's size is as it is shown: turned upright by its EXIF orientation", async () => {
  // stored 400 wide and 300 high, to be shown turned a quarter (orientation 6): 300 wide, 400 high
  const photo = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#3366cc" } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const image = await describe(photo, "image/jpeg");
  assert.deepEqual({ width: image?.width, height: image?.height }, { width: 300, height: 400 });
  const copy = await sharp(await scaled(photo, 240)).metadata();
  assert.deepEqual({ width: copy.width, height: copy.height }, { width: 240, height: 320 }, "the copy is upright too");
});

test("a GIF is described (it is not scaled); anything else, or a broken picture, is not", async () => {
  assert.deepEqual((await describe(await picture(40, 30, "gif"), "image/gif"))?.width, 40);
  assert.equal(scalable("image/gif"), false);
  assert.equal(scalable("image/jpeg"), true);
  assert.equal(await describe(new TextEncoder().encode("hello"), "text/plain"), undefined);
  assert.equal(await describe(new Uint8Array([137, 80, 78, 71, 13, 10]), "image/png"), undefined);
  assert.equal(await describe(await picture(40, 30, "png"), "image/svg+xml"), undefined);
});

test("a copy for the page is WebP, the width asked for, and never larger than the picture", async () => {
  const big = await picture(3000, 2000, "jpeg");
  const copy = await scaled(big, 960);
  const meta = await sharp(copy).metadata();
  assert.deepEqual({ format: meta.format, width: meta.width, height: meta.height }, { format: "webp", width: 960, height: 640 });
  assert.ok(copy.length < big.length);
  assert.equal((await sharp(await scaled(await picture(300, 200, "png"), 960)).metadata()).width, 300);
  await assert.rejects(scaled(new Uint8Array([1, 2, 3]), 480));
});

test("copies are kept up to a size, the least recently used let go first, and one being made is made once", async () => {
  const kept = previews(10);
  let made = 0;
  const make = (bytes: number) => async () => {
    made++;
    return Buffer.alloc(bytes);
  };
  const [a, again] = await Promise.all([kept.get("a", make(4)), kept.get("a", make(4))]);
  assert.equal(a, again);
  assert.equal(made, 1, "asked twice at once, made once");
  await kept.get("b", make(4));
  await kept.get("a", make(4)); // used again: now the newest
  await kept.get("c", make(4)); // 12 bytes: b goes
  assert.equal(kept.bytes, 8);
  assert.equal(made, 3);
  await kept.get("a", make(4));
  assert.equal(made, 3, "a was kept");
  await kept.get("b", make(4));
  assert.equal(made, 4, "b was made again");
  await kept.get("huge", make(11));
  assert.ok(kept.bytes <= 10, "one larger than the whole is served, not kept");
  await assert.rejects(kept.get("bad", () => Promise.reject(new Error("unreadable"))));
  assert.equal(await kept.get("bad", make(1)).then((b) => b.length), 1, "a failure is not kept");
});
