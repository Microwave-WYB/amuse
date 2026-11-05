/**
 * Heartbeats: work handed off is not left to itself. While a browser job or
 * a task is in flight, the chat agent is woken every so often with where it
 * stands (for how long, its status, its step or plan), to check on it, nudge
 * it, or tell the user, and to say nothing when all is well. A browser the
 * user holds, or one idle between jobs, is not in flight.
 */
import type { Entity } from "@amuse/protocol";

/** How long work runs before the first check, and between checks. */
export const BEAT_MS = 10 * 60_000;

/** A run whose progress the chat agent checks on: a browser job or a task, under way. */
export function inFlight(entity: Entity): boolean {
  if (entity.kind === "browser") return ["queued", "working", "waiting", "needs_you"].includes(entity.status);
  if (entity.kind === "task") return ["queued", "working", "waiting"].includes(entity.status);
  return false;
}

/** What the chat agent is told about a run that has been going `minutes`. */
export function beatNote(entity: Entity, minutes: number): string | null {
  const ask = "Check on it if it seems stuck or slow (message_run, or stop_run if it should stop); tell the user only what they need to hear. If all is well, just end the turn: this note shows the user nothing you end with.";
  if (entity.kind === "browser") {
    const where = entity.status === "needs_you" ? "it waits for the user to do something in the browser" : entity.status === "waiting" ? "it waits for an answer or an approval" : `it is ${entity.status}`;
    const step = entity.step ? `, now: ${entity.step}` : "";
    return `[heartbeat] Your browser task "${entity.title}" (${entity.id}) has been going ${minutes} minutes; ${where}${step}. ${ask}`;
  }
  if (entity.kind === "task") {
    const done = entity.steps.filter((s) => s.done).length;
    const plan = entity.steps.length > 0 ? `, ${done} of ${entity.steps.length} steps done${entity.steps.find((s) => !s.done) ? ` (next: ${entity.steps.find((s) => !s.done)?.label})` : ""}` : "";
    return `[heartbeat] Your task "${entity.title}" (${entity.id}) has been going ${minutes} minutes; it is ${entity.status}${plan}. ${ask}`;
  }
  return null;
}
