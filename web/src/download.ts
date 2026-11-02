/**
 * Saving a sent file on the phone, in the Android app. A file card stays a download link; the app takes the
 * download (into Downloads/Amuse, under the file's own name), or opens the saved copy when there is one, and
 * reports back on the file as `amuse-download` events on window, which its card shows. There is no bridge the
 * page calls: the app only answers the link. In a browser no events come, and the browser shows the download.
 */
import { useEffect, useState } from "react";

/** What the app reports for one file (by its id), as an event's `detail`. */
export type DownloadReport =
  | { id: string; state: "progress"; received: number; total: number }
  | { id: string; state: "saved" }
  /** saved, and no app on the phone opens it */
  | { id: string; state: "noApp" }
  | { id: string; state: "failed"; reason?: FailReason };

/** Why a download failed, in short: no connection, the server said no, or the phone could not keep the file. */
export type FailReason = "offline" | "server" | "storage";

export type DownloadState =
  | { kind: "idle" }
  /** `progress` from 0 to 1, or null while the size is not known */
  | { kind: "downloading"; progress: number | null }
  | { kind: "saved"; noApp: boolean }
  | { kind: "failed"; reason: FailReason | null };

export const idle: DownloadState = { kind: "idle" };

/** A card after the app reports on its file. */
export function reported(report: DownloadReport): DownloadState {
  switch (report.state) {
    case "progress":
      return { kind: "downloading", progress: report.total > 0 ? Math.min(1, report.received / report.total) : null };
    case "saved":
      return { kind: "saved", noApp: false };
    case "noApp":
      return { kind: "saved", noApp: true };
    case "failed":
      return { kind: "failed", reason: report.reason ?? null };
  }
}

/**
 * What a tap on a card does: download it (again, after a failure), have the app open the saved copy, or nothing
 * while it downloads (a second download of the same file would race the first).
 */
export function tapped(state: DownloadState): "download" | "open" | "wait" {
  return state.kind === "saved" ? "open" : state.kind === "downloading" ? "wait" : "download";
}

/** What sits at the card's end: a progress bar while it downloads, a retry button once it failed, or nothing. */
export function indicator(state: DownloadState): "progress" | "retry" | null {
  return state.kind === "downloading" ? "progress" : state.kind === "failed" ? "retry" : null;
}

/** Whether the page runs in the Android app, which takes downloads and reports on them. */
export const inApp = (agent = globalThis.navigator?.userAgent ?? "") => /\bAmuseAndroid\//.test(agent);

/** The last word on each file, for cards that mount later (the app says which are saved when the page loads). */
const known = new Map<string, DownloadState>();
const cards = new Set<() => void>();
globalThis.addEventListener?.("amuse-download", (event) => {
  const report = (event as CustomEvent<DownloadReport>).detail;
  if (typeof report?.id !== "string") return;
  known.set(report.id, reported(report));
  for (const card of cards) card();
});

/** A file card's download, in the app; null in a browser, where the link is all there is. */
export function useDownload(id: string) {
  const app = inApp();
  const [state, setState] = useState<DownloadState>(() => known.get(id) ?? idle);
  useEffect(() => {
    if (!app) return;
    const update = () => setState(known.get(id) ?? idle);
    cards.add(update);
    update();
    return () => void cards.delete(update);
  }, [app, id]);
  if (!app) return null;
  /** For a click on the card's link (or its retry button): false to keep the app from starting a second download. */
  const tap = () => {
    const action = tapped(state);
    if (action === "download") {
      known.set(id, { kind: "downloading", progress: null });
      setState({ kind: "downloading", progress: null });
    }
    return action !== "wait";
  };
  return { state, tap };
}
