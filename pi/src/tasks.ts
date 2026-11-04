/**
 * Tasks: work Muse hands to a background helper (a general agent, worker.ts)
 * so the chat goes on: long work it can do on its own, or several
 * independent pieces at once, one task each. Quick things Muse does itself.
 * The helper keeps its plan on the task's card, and comes back with what it
 * did: the task ends with that result, and Muse is told.
 */
import { type ToolDefinition, defineTool } from "@earendil-works/pi-coding-agent";
import { type AgentIO, type Ports, describe, nowIn } from "@amuse/core";
import { Type } from "typebox";
import type { PiConfig } from "./agent.ts";
import { status } from "./status.ts";
import { untrusted } from "./untrusted.ts";
import { briefed, clip, helperRules, helperTools, holding, work } from "./worker.ts";

type Text = { content: { type: "text"; text: string }[]; details: null };
const text = (value: string): Text => ({ content: [{ type: "text", text: value }], details: null });

/** The chat agent's tool for handing work off. */
export function taskTools(io: () => AgentIO): ToolDefinition[] {
  return [
    defineTool({
      name: "start_task",
      label: "Hand off a task",
      description:
        "Hand work to a background helper so you can keep talking with the user: work that is long and self-contained, or several independent pieces at once (one task each). Quick things you do yourself. The helper has your tools (it starts browser tasks for websites), sees the conversation as it stands, and only `instructions` besides; it shows the user a card with its plan, and you get its result.",
      parameters: Type.Object({
        status,
        title: Type.String({ description: "Short title the user will see, in their language" }),
        instructions: Type.String({ description: "Everything the helper must know, in full: what to do, what to bring back, every limit the user set" }),
      }),
      async execute(_, { title, instructions }) {
        const started = io().act({ kind: "task", title, instructions });
        return text(started.ok ? `Started task ${started.id}; it shows as a card and you get its result. Tell the user briefly.` : `Not started: ${describe(started.rejection)}.`);
      },
    }),
  ];
}

const helper = [
  ...helperRules,
  "This is one task Amuse handed you. First set out your plan with `plan` (a few short steps, in the user's language), and mark steps done as you go.",
  "When done, end with what you did and found, in the user's language, plain text: Amuse passes it on.",
].join("\n");

/** Runs tasks with Pi: a helper each; stopping one aborts it where it is. */
export function piTaskRunner(cfg: PiConfig): Pick<Ports, "task" | "stopTask"> {
  const running = new Map<string, () => void>();
  return {
    task: (task, io) =>
      void (async () => {
        const stop = new AbortController();
        running.set(task.id, () => stop.abort());
        const run = { id: task.id, title: task.title, noun: "task", io, stop: stop.signal, abort: () => stop.abort() };
        let steps: { label: string; done: boolean }[] = [];
        const plan = defineTool({
          name: "plan",
          label: "Plan",
          description: "Set out or update your plan: its steps in order, each done or not. The user sees it on the task's card.",
          parameters: Type.Object({ steps: Type.Array(Type.Object({ label: Type.String(), done: Type.Boolean() })) }),
          async execute(_, { steps: next }) {
            steps = next.slice(0, 12).map((s) => ({ label: clip(s.label, 80), done: s.done }));
            io.act({ kind: "taskSteps", id: task.id, steps });
            return text("Plan updated.");
          },
        });
        const { now, timezone } = io.time();
        const hold = holding(run, (waiting) => void io.act({ kind: "taskStatus", id: task.id, status: waiting ? "waiting" : "working" }));
        const worked = await work(cfg, run, helper, [...helperTools(cfg, run, hold), plan], (limits) => briefed(io, nowIn(now, timezone), `Task "${task.title}" (${task.id}). Instructions:\n${task.instructions}`, limits));
        running.delete(task.id);
        if (worked.kind === "stopped") return; // the stop is already recorded
        const result = worked.kind === "done" ? worked.record || "Done." : worked.reason;
        const status = worked.kind === "done" ? "completed" : "failed";
        if (status === "completed" && steps.length > 0) io.act({ kind: "taskSteps", id: task.id, steps: steps.map((s) => ({ ...s, done: true })) });
        if (io.act({ kind: "taskEnded", id: task.id, status, result: clip(result, 4000) }).ok)
          io.report(`[task "${task.title}" (${task.id}) ${status === "completed" ? "finished" : "failed"}]\n${untrusted(result)}`);
      })(),
    stopTask: (id) => running.get(id)?.(),
  };
}
