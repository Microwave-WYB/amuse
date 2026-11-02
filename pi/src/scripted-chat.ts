import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentIO, type Say, type Workspace, memoryRules } from "@amuse/core";
import type { Schedule } from "@amuse/protocol";
import { type FauxResponseStep, fauxProvider } from "@earendil-works/pi-ai";
import { type AgentSession, ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { piAgent } from "./agent.ts";
import { sessionOn } from "./session.ts";
import type { Skill } from "./skills.ts";

/**
 * For tests of the chat agent: it on a scripted model (pi-ai's faux provider), and a chat that records
 * what it says. Not a test itself.
 */
export async function chat(
  responses: FauxResponseStep[],
  { tools = [], opened, files, schedules = [], live = "", skills, codemode = false }: { tools?: ToolDefinition[]; opened?: (session: AgentSession) => void; files?: Workspace; schedules?: Schedule[]; live?: string; skills?: Skill[]; codemode?: boolean } = {},
) {
  const models = await ModelRuntime.create({ authPath: join(mkdtempSync(join(tmpdir(), "amuse-auth-")), "auth.json"), modelsPath: null, refreshOnCreate: false });
  const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted" }] });
  models.registerNativeProvider(faux.provider);
  faux.setResponses(responses);
  const said: Say[] = [];
  /** the chat so far, as the agent is given it: a test adds the user's lines as the server would record them */
  const conversation = ["[08:00] User: hello"];
  /** how many turns have ended (each one ends with the activity line cleared) */
  let ended = 0;
  let wake: (() => void) | undefined;
  const io: AgentIO = {
    chat: "main",
    chats: () => [{ id: "main", title: "Main chat", main: true, updated: "2026-10-21T08:00:00Z" }],
    schedules: () => schedules,
    readChat: () => null,
    emit: (say) => {
      said.push(say);
      if (say.kind === "activity" && say.activity === null) {
        ended++;
        wake?.();
      }
    },
    act: () => ({ ok: true, id: "x" }),
    decision: async () => ({ verdict: "denied", remember: false }),
    report: () => {},
    mention: () => {},
    running: () => live,
    context: () => conversation.join("\n"),
    recall: () => "",
    time: () => ({ now: "2026-10-21T08:00:00Z", timezone: "UTC" }),
    lastWords: () => "hello",
    answer: async () => ({ kind: "closed" }),
    listen: () => () => {},
  };
  const agent = piAgent({
    model: () => "faux/scripted",
    auth: { kind: "environment" },
    system: "You are a test.",
    ...(files ? { files } : {}),
    ...(skills ? { skills } : {}),
    rules: memoryRules(),
    open: async (system, own, caching) => {
      const made = await sessionOn(models, faux.getModel(), system, [...own, ...tools], { caching, codemode });
      opened?.(made.session);
      return made;
    },
  });
  /** resolves once `turns` turns have ended */
  const until = (turns: number) =>
    new Promise<void>((resolve) => {
      wake = () => ended >= turns && resolve();
      wake();
    });
  const replies = () => said.flatMap((s) => (s.kind === "upserted" && s.entity.kind === "reply" ? [s.entity.text] : []));
  /** what went wrong, as the cards the chat would show: the turn each was for */
  const failures = () => said.flatMap((s) => (s.kind === "upserted" && s.entity.kind === "failure" ? [s.entity.turn.kind] : []));
  return { agent, io, faux, conversation, replies, failures, until, said };
}
