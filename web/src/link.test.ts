/**
 * "Connecting…" on the badge: said once the link has not been live for a moment, and taken back as soon as it is,
 * so a check that a live socket answers at once does not flash it on every return.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Link } from "@amuse/api/client";
import { followLink } from "./link.ts";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function link(start: Link) {
  let now = start;
  const watchers = new Set<(link: Link) => void>();
  return {
    link: () => now,
    watch: (watcher: (link: Link) => void) => (watchers.add(watcher), () => void watchers.delete(watcher)),
    go(to: Link) {
      now = to;
      watchers.forEach((w) => w(to));
    },
  };
}

test("a check a live socket answers at once says nothing", async () => {
  const at = link("live");
  const said: boolean[] = [];
  const stop = followLink(at, (c) => said.push(c), 40);
  at.go("checking");
  await pause(10);
  at.go("live");
  await pause(60);
  stop();
  assert.equal(said.includes(true), false);
});

test("a link that stays down says connecting, until it is live again", async () => {
  const at = link("live");
  const said: boolean[] = [];
  const stop = followLink(at, (c) => said.push(c), 40);
  at.go("checking");
  at.go("connecting"); // the check went unanswered: a new socket on its way
  await pause(60);
  assert.equal(said.at(-1), true);
  at.go("live");
  assert.equal(said.at(-1), false, "at once");
  stop();
});

test("starting up: connecting is said if the first socket takes a while", async () => {
  const at = link("connecting");
  const said: boolean[] = [];
  const stop = followLink(at, (c) => said.push(c), 20);
  await pause(40);
  assert.equal(said.at(-1), true);
  stop();
});
