/**
 * Coming back to the page. A phone's browser freezes a backgrounded page, and the
 * socket with it: the retry that would take the connection up again is frozen too,
 * so the app can sit there "disconnected" long after the user is looking at it.
 * So the page says when it is back — on screen again, shown again from the bfcache,
 * the network back or changed (Wi-Fi to mobile data leaves a socket open on this side
 * only), or the Android app in front again (its WebView does not always say so to the
 * page) — and the session checks its socket, and takes it up again at once if it is gone.
 */

/** What the Android app dispatches on the window when its activity resumes (MainActivity.onResume). */
export const FOREGROUND = "amuse:foreground";

/** Where "the page is back" comes from: the browser's own events, or a test's. */
export interface Returns {
  events: EventTarget;
  /** where a change of network is heard, if the browser says (the Network Information API: Chrome and the WebView) */
  network?: EventTarget | undefined;
  visible: () => boolean;
}

/** The browser's: the window's events, the network's, and whether the page is on screen. */
export const browserReturns = (): Returns => ({
  events: window,
  network: "connection" in navigator && navigator.connection instanceof EventTarget ? navigator.connection : undefined,
  visible: () => document.visibilityState === "visible",
});

const RETURNS = ["visibilitychange", "pageshow", "online"];

/** Run `resume` whenever the page comes back; returns how to stop listening. */
export function resumeOnReturn(resume: () => void, from: Returns = browserReturns()): () => void {
  const back = () => {
    if (from.visible()) resume();
  };
  // the app says it is in front, whatever the WebView has told the page yet
  const front = () => resume();
  for (const event of RETURNS) from.events.addEventListener(event, back);
  from.events.addEventListener(FOREGROUND, front);
  from.network?.addEventListener("change", back);
  return () => {
    for (const event of RETURNS) from.events.removeEventListener(event, back);
    from.events.removeEventListener(FOREGROUND, front);
    from.network?.removeEventListener("change", back);
  };
}
