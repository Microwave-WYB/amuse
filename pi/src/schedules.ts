/**
 * Work for later. The chat agent sets schedules up (schedule, cancel_schedule);
 * when one's time comes, a background agent runs it apart from the chat:
 * briefed with the schedule's instructions and a copy of the conversation as
 * it stands, it does the work with the same tools and rules as the chat
 * agent, and tells the conversation only what is worth telling (`report`).
 * A briefing down, a report up; no reply to the user of its own.
 */
import { type ToolDefinition, defineTool } from "@earendil-works/pi-coding-agent";
import { type AgentIO, type Ports, type Workspace, describe, localTime, noteGoal, nowIn, readGoal, wallClock } from "@amuse/core";
import type { Chat, RunOutcome, Schedule, When } from "@amuse/protocol";
import { Type } from "typebox";
import type { PiConfig } from "./agent.ts";
import { briefed, clip, helperRules, helperTools, holding, work } from "./worker.ts";
import { status } from "./status.ts";

type Text = { content: { type: "text"; text: string }[]; details: null };
const text = (value: string): Text => ({ content: [{ type: "text", text: value }], details: null });

const QUIET_MS = 20 * 60_000;
const LULL_GAP_MS = 4 * 60 * 60_000;

/**
 * Whether a run is worth starting (Schedule.needs): conversation since its last run; for a lull,
 * also quiet for a while now, and the last run hours back. Checked before any model is asked.
 */
export function worthRunning(schedule: Schedule, chats: Pick<Chat, "updated">[], now: string): boolean {
  if (!schedule.needs) return true;
  const since = Date.parse(schedule.last?.at ?? schedule.at);
  const latest = Math.max(0, ...chats.map((c) => Date.parse(c.updated)));
  if (latest <= since) return false;
  if (schedule.needs === "conversation") return true;
  return Date.parse(now) - latest >= QUIET_MS && Date.parse(now) - since >= LULL_GAP_MS;
}

/** What the agent asked for, as a When on the user's clock; or why it cannot be one. */
export function whenOf(args: { cron?: string; at?: string; timezone?: string }, userZone: string): { ok: true; when: When } | { ok: false; reason: string } {
  const timezone = args.timezone?.trim() || userZone;
  if (args.cron && args.at) return { ok: false, reason: "give either `cron` or `at`, not both" };
  if (args.cron) return { ok: true, when: { kind: "repeat", cron: args.cron.trim(), timezone } };
  if (args.at) {
    const at = wallClock(args.at, timezone);
    return at ? { ok: true, when: { kind: "once", at } } : { ok: false, reason: `"${args.at}" is not a time like 2026-10-21 08:00 in ${timezone}` };
  }
  return { ok: false, reason: "give `cron` for a repeating schedule or `at` for a one-off" };
}

/** A schedule as list_schedules gives it: a line with what the agent needs to name it and tell the user about it. */
export function scheduleLine(schedule: Schedule, timezone: string): string {
  const when = schedule.when.kind === "repeat" ? `repeats ${schedule.when.cron} (${schedule.when.timezone})` : `once at ${localTime(schedule.when.at, timezone)}`;
  const next = schedule.next ? `next ${localTime(schedule.next, timezone)}` : "no next run";
  const kind = schedule.preset ? "; built-in upkeep" : "";
  return `${schedule.id} | ${schedule.title} | ${schedule.status}${kind} | ${when} | ${next}`;
}

/** The chat agent's tools for setting schedules up, looking them over and cancelling them. */
export function scheduleTools(io: () => AgentIO, files?: Workspace): ToolDefinition[] {
  return [
    defineTool({
      name: "schedule",
      label: "Schedule",
      description:
        "Set up work to run later or regularly, e.g. a briefing every morning at 8, a look at the mail every hour, a reminder tomorrow at 9. " +
        "Each run is a background agent with your tools that gets only `instructions` and the conversation; it tells the user only what is worth telling. " +
        "Times are the user's own (their time zone unless `timezone` says otherwise). `list_schedules` shows the ones there are.",
      parameters: Type.Object({
        status,
        title: Type.String({ description: "Short name the user will see, in their language, e.g. 'Morning briefing'" }),
        instructions: Type.String({
          description:
            "Everything a run must know, in full: what to do, what is worth telling the user and what is not (e.g. 'report only mail that needs an answer today'), and every limit the user set.",
        }),
        cron: Type.Optional(Type.String({ description: "Repeating: a 5-field cron pattern (minute hour day-of-month month day-of-week), e.g. '0 8 * * *' for every day at 8:00, '0 * * * *' hourly. At most every 15 minutes." })),
        at: Type.Optional(Type.String({ description: "One-off: the user's local date and time, 'YYYY-MM-DD HH:mm'" })),
        timezone: Type.Optional(Type.String({ description: "An IANA time zone, only if the user names one other than their own" })),
        goal: Type.Optional(
          Type.String({
            description:
              "The user's goal this serves, by its id (its folder in memory/goals/, e.g. 'gain-weight'), e.g. meal reminders for a weight goal. It shows on the goal's page, rests while the goal is done, and stays quiet while the goal is muted.",
          }),
        ),
        needs: Type.Optional(
          Type.Union([Type.Literal("conversation"), Type.Literal("lull")], {
            description:
              "Only for upkeep that is pointless when nothing happened (keeping notes from conversations): 'conversation' runs only if there was conversation since the last run; 'lull' once a conversation has gone quiet (at most every 4 hours). Never for what the user wants at its time (a reminder, a briefing, a check of their mail): leave it out.",
          }),
        ),
      }),
      async execute(_, { title, instructions, cron, at, timezone, needs, goal }) {
        const agent = io();
        const served = goal?.trim() ? (files ? await readGoal(files, goal.trim()).catch(() => null) : null) : null;
        if (goal?.trim() && !served) return text(`Not scheduled: there is no goal "${goal}" (goals are the folders in memory/goals/).`);
        const { timezone: zone } = agent.time();
        const when = whenOf({ ...(cron ? { cron } : {}), ...(at ? { at } : {}), ...(timezone ? { timezone } : {}) }, zone);
        if (!when.ok) return text(`Not scheduled: ${when.reason}.`);
        const made = agent.act({ kind: "schedule", title, instructions, when: when.when, needs: needs ?? null, goal: served?.id ?? null });
        if (!made.ok) return text(`Not scheduled: ${describe(made.rejection)}.`);
        return text(`Scheduled ${made.id}. Tell the user briefly when it will run (their time zone is ${zone}); the schedule shows in the chat.`);
      },
    }),
    defineTool({
      name: "list_schedules",
      label: "List schedules",
      description:
        "The schedules there are now, active and paused: each with its full id, title, when it runs and when next. Look here for the id before you cancel one, rather than from memory. " +
        "With `id`, that one schedule with its full instructions: read them before you change a schedule (cancel it and set it up again), so nothing the user asked for in it is lost.",
      parameters: Type.Object({ status, id: Type.Optional(Type.String({ description: "A schedule's full id, for its full instructions" })) }),
      async execute(_, { id }) {
        const agent = io();
        const { timezone } = agent.time();
        if (id?.trim()) {
          const one = agent.schedules().find((s) => s.id === id.trim());
          return text(one ? `${scheduleLine(one, timezone)}\nInstructions (in full):\n${one.instructions}` : `There is no schedule ${id}.`);
        }
        const now = agent.schedules().filter((s) => s.status === "active" || s.status === "paused");
        if (now.length === 0) return text("There are no schedules.");
        return text(now.map((s) => scheduleLine(s, timezone)).join("\n"));
      },
    }),
    defineTool({
      name: "cancel_schedule",
      label: "Cancel a schedule",
      description: "Cancel one of your schedules for good, by its full id (e.g. s-…, as list_schedules gives it), when the user no longer wants it.",
      parameters: Type.Object({ status, id: Type.String() }),
      async execute(_, { id }) {
        const done = io().act({ kind: "unschedule", id });
        return text(done.ok ? `Cancelled ${id}.` : `Not cancelled: ${describe(done.rejection)}.`);
      },
    }),
  ];
}

const background = [
  ...helperRules,
  "This run is one scheduled task.",
  "If there is something the user should hear, call `report` once with it: one to three short sentences of plain prose in the user's language, no headings or bullet lists. If nothing is worth telling (no new mail that matters, nothing changed), do not report: the user is not to be bothered for nothing.",
  "When done, end with one short line, in the user's language, on what you did and found; it is kept as the run's record, not shown in the chat.",
].join("\n");

/** Runs schedules with Pi: a helper each (worker.ts), with `report` to tell the user what is worth telling. */
export function piScheduleRunner(cfg: PiConfig): Pick<Ports, "schedule"> {
  return {
    schedule: (schedule, io) =>
      void (async () => {
        // nothing to do yet: no model is asked, and it does not count as a run
        if (!worthRunning(schedule, io.chats(), io.time().now)) return void io.act({ kind: "scheduleRan", id: schedule.id, outcome: "skipped", summary: "" });
        // the work for a goal rests while the goal is done, and goes on once it is taken up again
        const goal = schedule.goal !== null && cfg.files ? await readGoal(cfg.files, schedule.goal).catch(() => null) : null;
        if (goal?.status === "done") return void io.act({ kind: "scheduleRan", id: schedule.id, outcome: "skipped", summary: "" });
        const stop = new AbortController();
        const run = { id: schedule.id, title: schedule.title, noun: "scheduled task", io, stop: stop.signal, abort: () => stop.abort() };
        let reported = false;
        let kept = false;
        const report = defineTool({
          name: "report",
          label: "Tell the user",
          description: "Tell the user something worth their attention from this task. Once per run, only when it matters.",
          parameters: Type.Object({ message: Type.String({ description: "What the user should hear, in their language, plain text" }) }),
          async execute(_, { message }) {
            if (reported || kept) return text("Already reported this run.");
            // a muted goal's work tells the user nothing unasked: what it would have said goes in the goal's log
            if (goal?.muted && cfg.files) {
              kept = true;
              const { now, timezone } = io.time();
              await noteGoal(cfg.files, goal.id, localTime(now, timezone).split(" ")[0] ?? "", `From ${schedule.title}`, message);
              return text(`The user muted the goal "${goal.title}", so this went in its log instead of to them. Finish with your one-line record.`);
            }
            reported = true;
            io.report(`[scheduled task "${schedule.title}" (${schedule.id})]\n${message}`);
            return text("Reported. Finish with your one-line record.");
          },
        });
        const { now, timezone } = io.time();
        const worked = await work(
          cfg,
          run,
          background,
          [...helperTools(cfg, run, holding(run)), report],
          briefed(io, nowIn(now, timezone), `Scheduled task "${schedule.title}" (${schedule.id}). Instructions:\n${schedule.instructions}`),
        );
        const end = (outcome: Exclude<RunOutcome, "missed">, summary: string) => io.act({ kind: "scheduleRan", id: schedule.id, outcome, summary: clip(summary) });
        switch (worked.kind) {
          case "stopped":
            return void end("stopped", "Stopped by Amuse");
          case "failed":
            return void end(reported ? "reported" : "failed", worked.reason);
          case "done":
            return void end(reported ? "reported" : "quiet", worked.record || (reported ? "Reported" : "Nothing to report"));
        }
      })(),
  };
}
