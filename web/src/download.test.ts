import assert from "node:assert/strict";
import { test } from "node:test";
import { type DownloadState, idle, inApp, indicator, reported, tapped } from "./download.ts";

test("a card downloads on a tap, shows how far it got, and opens once saved", () => {
  assert.equal(tapped(idle), "download");
  let state: DownloadState = { kind: "downloading", progress: null };
  assert.equal(tapped(state), "wait", "a second tap does not start it twice");
  state = reported({ id: "f", state: "progress", received: 25, total: 100 });
  assert.deepEqual(state, { kind: "downloading", progress: 0.25 });
  assert.equal(tapped(state), "wait");
  assert.deepEqual(
    reported({ id: "f", state: "progress", received: 10, total: 0 }),
    { kind: "downloading", progress: null },
    "a size the server did not give is unknown, not 0%",
  );
  assert.deepEqual(reported({ id: "f", state: "progress", received: 120, total: 100 }), { kind: "downloading", progress: 1 });
  state = reported({ id: "f", state: "saved" });
  assert.deepEqual(state, { kind: "saved", noApp: false });
  assert.equal(tapped(state), "open");
  state = reported({ id: "f", state: "noApp" });
  assert.deepEqual(state, { kind: "saved", noApp: true });
  assert.equal(tapped(state), "open", "after no app took it, a tap tries again");
});

test("a failed download stays on its card with why, and its retry button starts it again", () => {
  assert.equal(indicator(idle), null);
  const downloading = reported({ id: "f", state: "progress", received: 1, total: 2 });
  assert.equal(indicator(downloading), "progress");
  const failed = reported({ id: "f", state: "failed", reason: "offline" });
  assert.deepEqual(failed, { kind: "failed", reason: "offline" });
  assert.equal(indicator(failed), "retry", "the retry button takes the progress bar's place");
  assert.equal(tapped(failed), "download", "retrying downloads again");
  assert.deepEqual(reported({ id: "f", state: "failed" }), { kind: "failed", reason: null }, "a reason the app did not give is none");
  // the retry runs like the first try: progress, then saved
  const again = reported({ id: "f", state: "progress", received: 0, total: 2 });
  assert.equal(indicator(again), "progress");
  assert.equal(indicator(reported({ id: "f", state: "saved" })), null);
});

test("only the Android app takes the download over", () => {
  assert.equal(inApp("Mozilla/5.0 (Linux; Android 15) Chrome/130 Mobile Safari/537.36 AmuseAndroid/0.3.0"), true);
  assert.equal(inApp("Mozilla/5.0 (Linux; Android 15) Chrome/130 Mobile Safari/537.36"), false);
  assert.equal(inApp("NotAmuseAndroid/1"), false);
});
