/**
 * Whether the page says it is connecting: the link to the server is not live (down, on its way up, or being checked
 * after the page came back). Said only once that has lasted a moment, so a check a live socket answers at once, or a
 * reconnect that is quick, does not flash it on every return.
 */
import { useEffect, useState } from "react";
import type { Link } from "@amuse/api/client";

/** how long the link is not live before the page says so, in ms */
export const SHOW_AFTER = 600;

/** The link as a page watches it: how it stands, and every change. */
export interface Watched {
  link(): Link;
  watch(listener: (link: Link) => void): () => void;
}

/** A link that is always live (the demo, which runs in the page). */
export const alwaysLive: Watched = { link: () => "live", watch: () => () => {} };

/**
 * Follow a link, calling `show` with whether to say "connecting": true once it has not been live for `after` ms,
 * false as soon as it is. Returns how to stop.
 */
export function followLink(watched: Watched, show: (connecting: boolean) => void, after = SHOW_AFTER): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const seen = (link: Link) => {
    if (link === "live") {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      return show(false);
    }
    timer ??= setTimeout(() => show(true), after);
  };
  seen(watched.link());
  const stop = watched.watch(seen);
  return () => {
    stop();
    if (timer !== null) clearTimeout(timer);
  };
}

export function useConnecting(watched: Watched): boolean {
  const [connecting, setConnecting] = useState(false);
  useEffect(() => followLink(watched, setConnecting), [watched]);
  return connecting;
}
