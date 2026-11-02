/**
 * How protocol values look on screen: status copy and colors (Muse's
 * wording), times, and the agent line under the avatar. Pure functions of
 * the conversation; nothing here is state.
 */
import type { Activity, Browser, BrowserStatus, Entity, State, TaskStatus } from "@amuse/protocol";
import type { Messages } from "./i18n/en.ts";
import { activeLocale, activeT } from "./i18n/language.ts";

const BROWSER_COLOR: Record<BrowserStatus, string> = {
  queued: "var(--icon-secondary)",
  working: "var(--fill-blue)",
  waiting: "var(--fill-orange)",
  needs_you: "var(--fill-orange)",
  paused: "var(--fill-orange)",
  idle: "var(--icon-secondary)",
  completed: "var(--fill-green)",
  failed: "var(--fill-red)",
  stopped: "var(--icon-secondary)",
};

const TASK_COLOR: Record<TaskStatus, string> = {
  queued: "var(--icon-secondary)",
  working: "var(--fill-orange)",
  waiting: "var(--fill-orange)",
  completed: "var(--fill-green)",
  failed: "var(--fill-red)",
  stopped: "var(--icon-secondary)",
};

/** A browser's status, as its label and color on screen. */
export function browserStatus(status: BrowserStatus, t: Messages = activeT()): { label: string; color: string } {
  return { label: t.status.browser[status], color: BROWSER_COLOR[status] };
}

/**
 * How a browser reads: its status, but between jobs how the last one went
 * (Done, Couldn't finish, or Ready when it has had none), and Closed once its
 * browser is gone.
 */
export function browserLook(b: Browser, t: Messages = activeT()): { label: string; color: string } {
  if (b.status === "idle" && !b.live) return { label: t.status.closed, color: "var(--icon-secondary)" };
  if (b.status === "idle" && b.outcome === "completed") return { label: t.status.done, color: "var(--fill-green)" };
  if (b.status === "idle" && b.outcome === "failed") return { label: t.status.couldntFinish, color: "var(--fill-red)" };
  return browserStatus(b.status, t);
}

/** A task's status, as its label and color on screen. */
export function taskStatus(status: TaskStatus, t: Messages = activeT()): { label: string; color: string } {
  return { label: t.status.task[status], color: TASK_COLOR[status] };
}

/** Muse shows the task banner only while a run is in flight. */
export const bannerActive = (b: Browser) =>
  b.status === "working" || b.status === "waiting" || b.status === "needs_you" || b.status === "paused";

/** Runs that can still be stopped. */
export const stoppable = (b: Browser) => b.status !== "completed" && b.status !== "failed" && b.status !== "stopped";

/** The line under the agent's name: its activity, or "Needs approval" while one is pending. */
/** `connecting`: not Muse's, the page's own (the link to the server is not live) */
export type AgentLine = { icon: "list" | "tool" | "approval" | "connecting"; text: string };

export function agentLine(state: State, t: Messages = activeT()): AgentLine | null {
  const { activity } = state;
  if (activity) return { icon: activity.kind === "responding" ? "list" : "tool", text: activity.label ?? t.status.activity[activity.kind] };
  // the chat agent is idle: what a browser run's agent is doing, newest first
  const stepping = browsers(state).findLast((b) => b.live && b.step !== null);
  if (stepping?.step) return { icon: "tool", text: stepping.step };
  return state.entities.some((e) => e.kind === "approval" && e.status === "pending") ? { icon: "approval", text: t.status.needsApproval } : null;
}

/** Thinking dots: the chat agent is at work on a reply (thinking, or using a tool) and no reply text is coming in yet. */
export const thinking = (state: State) => state.activity !== null && !state.entities.some((e) => e.kind === "reply" && e.streaming);

export const busy = (state: State) => state.activity !== null;

export const time = (iso: string) => new Date(iso).toLocaleTimeString(activeLocale(), { hour: "numeric", minute: "2-digit" });

export const host = (url: string) => new URL(url).host;
export const path = (url: string) => new URL(url).pathname;

/** Stable hue per id, for sketched page thumbnails. */
export const hue = (id: string) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

export const browsers = (state: State) => state.entities.filter((e): e is Browser => e.kind === "browser");

/** Runs whose browser is still there: the viewer's tabs (closed tabs aside). */
/** The browsers open now, one tab each (a closed one is only a card in the chat). */
export const viewerTabs = (state: State) => browsers(state).filter((b) => b.live);

/** The run the viewer shows: the chosen one while it is a tab, else the newest tab; none when there is no browser. */
export const viewerRun = (state: State, viewer: { browserId: string | null }) => {
  const tabs = viewerTabs(state);
  return tabs.find((b) => b.id === viewer.browserId) ?? tabs.at(-1) ?? null;
};

export function byId<K extends Entity["kind"]>(state: State, kind: K, id: string | null) {
  return state.entities.find((e): e is Extract<Entity, { kind: K }> => e.kind === kind && e.id === id);
}

/** The run the task indicator follows: newest one that needs the user, else newest in flight. */
export function pillBrowser(state: State): Browser | undefined {
  const live = browsers(state).filter((b) => b.live && bannerActive(b)).reverse();
  return live.find((b) => b.status === "needs_you" || b.status === "waiting") ?? live[0];
}

/** A connector app's logo, by its provider id (Composio serves one for each). */
export const providerLogo = (provider: string) => `https://logos.composio.dev/api/${encodeURIComponent(provider)}`;
