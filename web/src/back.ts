/**
 * The device's Back (a phone's back gesture, the browser's back button)
 * closes what is open, one layer at a time, before it leaves the app. The
 * open layers are a function of the UI state; each gets an entry in the
 * page's history, so Back pops the top one.
 */
import { useEffect, useRef } from "react";
import type { Ui } from "./ui.ts";

export type Layer =
  | "left"
  | "goal"
  | "skill"
  | "muse"
  | "chats"
  | "viewer"
  | "settings"
  | "section"
  | "app"
  | "provider"
  | "entry"
  | "taskDetail"
  | "explainer"
  | "photo";

/**
 * What is open, bottom to top. A settings section is a layer of its own
 * only on a phone, where it is a page over the list; on a desktop it is a tab.
 */
export function layers(ui: Ui, phone: boolean): Layer[] {
  const open: [Layer, boolean][] = [
    ["left", ui.left !== null],
    ["goal", ui.left === "goals" && ui.goal !== null],
    ["skill", ui.left === "skills" && ui.skill !== null],
    ["muse", ui.museOpen],
    ["chats", ui.chatsOpen],
    ["viewer", ui.viewer !== null],
    ["settings", ui.settings.open],
    ["section", ui.settings.open && phone && ui.settings.section !== null],
    ["app", ui.settings.open && ui.settings.app !== null],
    ["provider", ui.settings.open && ui.settings.provider !== null],
    ["entry", ui.settings.open && ui.settings.entry !== null],
    ["taskDetail", ui.taskDetail !== null],
    ["explainer", ui.explainer !== null],
    ["photo", ui.photo !== null],
  ];
  return open.filter(([, on]) => on).map(([layer]) => layer);
}

/** `ui` with `layer` closed, and nothing else changed. */
export function close(ui: Ui, layer: Layer): Ui {
  switch (layer) {
    case "left":
      return { ...ui, left: null, goal: null, skill: null };
    case "goal":
      return { ...ui, goal: null };
    case "skill":
      return { ...ui, skill: null };
    case "muse":
      return { ...ui, museOpen: false };
    case "chats":
      return { ...ui, chatsOpen: false };
    case "viewer":
      return { ...ui, viewer: null };
    case "settings":
      return { ...ui, settings: { ...ui.settings, open: false } };
    case "section":
      return { ...ui, settings: { ...ui.settings, section: null, app: null, provider: null, entry: null } };
    case "app":
      return { ...ui, settings: { ...ui.settings, app: null } };
    case "provider":
      return { ...ui, settings: { ...ui.settings, provider: null } };
    case "entry":
      return { ...ui, settings: { ...ui.settings, entry: null } };
    case "taskDetail":
      return { ...ui, taskDetail: null };
    case "explainer":
      return { ...ui, explainer: null };
    case "photo":
      return { ...ui, photo: null };
  }
}

const phone = () => matchMedia("(max-width: 639px)").matches;

/**
 * Keep one history entry per open layer: an entry is added as a layer
 * opens, Back closes the top layer (`closeTop`), and entries are taken back
 * when layers close some other way (their own buttons).
 */
export function useBack(ui: Ui, closeTop: (layer: Layer) => void): void {
  const depth = layers(ui, phone()).length;
  const entries = useRef(0); // history entries this page has added and not yet taken back
  const unwinding = useRef(false); // the next popstate is ours, taking entries back
  const top = useRef<Layer | undefined>(undefined);
  top.current = layers(ui, phone()).at(-1);
  const closeRef = useRef(closeTop);
  closeRef.current = closeTop;

  useEffect(() => {
    if (depth > entries.current) {
      for (; entries.current < depth; entries.current++)
        history.pushState({ amuse: entries.current + 1 }, "");
    } else if (depth < entries.current && !unwinding.current) {
      unwinding.current = true;
      history.go(depth - entries.current);
      entries.current = depth;
    }
  }, [depth]);

  useEffect(() => {
    const onPop = () => {
      if (unwinding.current) {
        unwinding.current = false;
        return;
      }
      entries.current = Math.max(0, entries.current - 1);
      if (top.current) closeRef.current(top.current);
    };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
}
