/**
 * A general agent: a background helper with Muse's tools, run apart from the
 * chat on one piece of work (a task handed off, a schedule's run). It is
 * briefed once (the work, and a copy of the conversation as it stands), hears
 * Muse while it works (instructions, a stop), may ask the user, and comes
 * back with what it did. It never drives a browser itself: for a website it
 * starts a browser task (a browser agent, one level down, the only agent that
 * operates a browser); and it hands off no work of its own.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type AgentIO, type Budget, budgetForWindow } from "@amuse/core";
import type { PiConfig } from "./agent.ts";
import { workspaceTools } from "./attachments.ts";
import { redact } from "./redact.ts";
import { sandboxTools } from "./sandbox.ts";
import { secretTools } from "./secrets.ts";
import { type Hold, type RunHandle, askTool, inbox } from "./runs.ts";
import { type PiSession, openSession, secretsOf } from "./session.ts";
import { appTools, chatTools, tools } from "./tools.ts";
import { memoryReadTools } from "./memory.ts";
import { allSkills, catalog, skillTools } from "./skills.ts";
import { untrustedRule } from "./untrusted.ts";
import { webTools } from "./web.ts";
import { aboutTools } from "./about.ts";

/** How a helper's work went: done (with its closing words), failed (why), or stopped by Muse. */
export type Worked = { kind: "done"; record: string } | { kind: "failed"; reason: string } | { kind: "stopped" };

/** What every helper is told, before the work's own rules. */
export const helperRules = [
  "You are a background helper of a personal assistant (Amuse). You are not in the chat: nothing you write reaches the user directly.",
  "Do the work with your tools. Reading runs at once; what sends, changes or deletes may go to the user for approval: then that step waits for them, and if they decline or do not answer, it is not done; never try another way around it.",
  "For a website that must be operated (log in, fill, click), start a browser task with `browse`; you cannot operate a browser yourself.",
  "If you need an answer only the user has, ask with `ask_user` (it waits for them, and may get no answer). Messages from Amuse may arrive while you work: follow them.",
  "Never claim something you did not do or see.",
  untrustedRule,
];

/**
 * The tools every helper has: Muse's, but no browser of its own (it may start browser tasks), no
 * handing off, no asking to connect. Its steps that need the user's approval hold until they answer (`hold`).
 */
export function helperTools(cfg: PiConfig, run: RunHandle, hold: Hold): ToolDefinition[] {
  const io = () => run.io;
  return [
    ...tools(io, cfg.rules, { files: cfg.files, hold }).filter((t) => t.name !== "request_connection" && !(cfg.files && t.name === "recall")),
    // what was said, and what is remembered: to look up (memory files are kept with the workspace tools)
    ...chatTools(io),
    ...(cfg.files ? memoryReadTools(io, cfg.files) : []),
    ...skillTools(cfg.skills ?? [], cfg.files),
    ...(cfg.about ? aboutTools(cfg.about) : []),
    ...webTools(io, cfg.rules, cfg.search, hold),
    ...(cfg.apps ? appTools(io, cfg.apps, hold) : []),
    ...(cfg.files ? workspaceTools(io, cfg.files, { send: false }) : []),
    ...(cfg.sandbox ? sandboxTools(cfg.sandbox) : []),
    ...(cfg.secrets ? secretTools(io, { ...cfg.secrets, sandbox: cfg.sandbox !== undefined }, hold) : []),
    askTool(run),
  ];
}

/**
 * The work and the conversation as a helper is briefed on them: the conversation first, which it shares with the chat's other
 * helpers and the chat itself (the provider reuses what a request begins with, context.ts), then the time and the work.
 */
export function briefed(io: Pick<AgentIO, "context">, now: string, work: string, limits?: Budget): string {
  return [`The conversation with the user so far, for background only (do not answer it):\n\n${io.context(limits)}`, `---\nNow: ${now}.\n${work}`].join("\n\n");
}

/** Run one helper to the end of its work: `system` its rules, `tools` everything it may use, `briefing` the work. */
export async function work(
  cfg: PiConfig,
  run: RunHandle & { abort(): void },
  system: string,
  toolset: ToolDefinition[],
  /** the work and the conversation, made once this run's model is known, so the window is that model's */
  briefing: (limits: Budget) => string,
): Promise<Worked> {
  let session: PiSession | null = null;
  // Muse's messages reach the helper before its next step; its stop ends the work where it is
  const mail = inbox(run, () => session?.session ?? null, () => {
    run.abort();
    void session?.session.abort().catch(() => {});
  });
  let record = "";
  try {
    // a helper reads up as the chat agent does
    const skills = catalog(await allSkills(cfg.skills ?? [], cfg.files));
    session = await openSession(cfg, [system, skills].filter(Boolean).join("\n\n"), toolset, { codemode: true });
    try {
      let current = "";
      let failure: string | undefined;
      const unsubscribe = session.session.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") current += event.assistantMessageEvent.delta;
        else if (event.type === "message_end" && event.message.role === "assistant") {
          if (event.message.stopReason === "error") failure = event.message.errorMessage ?? "The model run failed";
          if (current.trim()) record = current.trim();
          current = "";
        }
      });
      try {
        const limits = budgetForWindow(session.contextWindow, system.length + JSON.stringify(toolset).length);
        const said = briefing(limits);
        if (!run.stop.aborted) await session.session.prompt([said, mail.drain()].filter(Boolean).join("\n\n"), { expandPromptTemplates: false });
      } finally {
        unsubscribe();
      }
      if (run.stop.aborted) return { kind: "stopped" };
      if (failure !== undefined) throw new Error(failure);
    } finally {
      session.close();
    }
    return { kind: "done", record };
  } catch (error) {
    if (run.stop.aborted) return { kind: "stopped" };
    return { kind: "failed", reason: redact(error instanceof Error ? error.message : String(error), secretsOf(cfg)) };
  } finally {
    mail.close();
  }
}

/** A helper's hold: Muse is told once what waits on the user (to tell them why a card appeared); `status` shows it on the card, where there is one. */
export function holding(run: RunHandle, status?: (waiting: boolean) => void): Hold {
  return {
    waiting(what) {
      status?.(true);
      run.io.report(`[${run.noun} "${run.title}" (${run.id}) waits for the user's approval] ${what}`);
    },
    working: () => status?.(false),
  };
}

export const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
