/**
 * The agent port on Pi (@earendil-works/pi-coding-agent). The conversation
 * lives in amuse's events, not in Pi: each turn is a fresh Pi session given
 * the conversation as the core renders it (context.ts), so a restart loses
 * nothing and the context never outgrows the model. Its reply is what it
 * says once it is done (no more tools); what it writes on the way is not shown
 * (the status line says what it is doing). Pi's coding tools, extensions,
 * skills and context files are all off: the model sees only amuse's tools (tools.ts).
 */
import { type AgentIO, type Ports, type Rules, type Turn, type Workspace, attached, blank, closedParts, newId, nowIn, quoted, withJobs } from "@amuse/core";
import { images, workspaceTools } from "./attachments.ts";
import { memoryBrief, memoryReadTools, memoryWriteTools } from "./memory.ts";
import { aboutTools } from "./about.ts";
import { type Skill, allSkills, catalog, skillTools } from "./skills.ts";
import type { Needs, Reply } from "@amuse/protocol";
import type { SandboxClient } from "@amuse/sandbox";
import { redact } from "./redact.ts";
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Caching, type PiModelConfig, type PiSession, openSession, secretsOf } from "./session.ts";
import { statusOf } from "./status.ts";
import { relayTools } from "./runs.ts";
import { type BrowserLook, browserReadTools } from "./browser-read.ts";
import { taskTools } from "./tasks.ts";
import { scheduleTools } from "./schedules.ts";
import { type JobBook, jobBook } from "./jobs.ts";
import { type SecretAccess, secretTools } from "./secrets.ts";
import { sayTools, silenceTools, suggestTools } from "./silence.ts";
import { type Apps, appTools, chatTools, tools } from "./tools.ts";
import { type Search, webTools } from "./web.ts";

export interface PiConfig extends PiModelConfig {
  system: string;
  /** Connected apps the agent may use; without them it can only ask to connect. */
  apps?: Apps;
  /** the user's rules (sites the agent may not browse) */
  rules: Rules;
  /** A web search, where one is configured (web_read works without). */
  search?: Search;
  /** Muse's workspace: the files it and the user share. */
  files?: Workspace;
  /** Its own machine to run commands in (the chat agent and its helpers; not the browser agent); without one, no such tools. */
  sandbox?: SandboxClient;
  /** The browsers, to look at a page a task is on (read_browser); acting in one stays with the browser agent. */
  browsers?: BrowserLook;
  /** The Vault, and the keys (to ask for one of Amuse's own): the agent's tools for secrets. */
  secrets?: Omit<SecretAccess, "sandbox">;
  /** While apps are not set up: how the user sets them up (null once they are). */
  appsSetup?: () => string | null;
  /** When a service cannot be connected here at all: the words for the agent, instead of a card (null when it can). */
  appsFit?: (app: string) => Promise<string | null>;
  /** The skills that ship with Amuse (the user's own are read from skills/ in the workspace). */
  /** How this instance is set up right now (models, apps, browsers, sandbox), for `amuse_status`. */
  about?: () => Promise<string>;
  skills?: Skill[];
  /** Schedules every instance starts with (memory upkeep, reflection), each set up once, on the user's clock, when they write. */
  defaults?: Defaults;
  /** Where a turn's Pi session comes from (tests give one with a scripted model); the configured model's by default. */
  open?: (system: string, tools: ToolDefinition[], caching: Caching) => Promise<PiSession>;
}

/** A schedule every instance starts with; after that it is the user's like any other. */
export interface DefaultSchedule {
  /** which default it is, for good (the title may change) */
  key: string;
  title: string;
  instructions: string;
  /** on the user's clock */
  cron: string;
  needs: Needs | null;
}

export interface Defaults {
  schedules: DefaultSchedule[];
  /** the keys of those set up already (each once only: the user may have changed or cancelled it since) */
  setUp(): string[];
  markSetUp(keys: string[]): void;
}

/** Set up, in the main chat, the default schedules not set up yet (one added in a later version too), on the user's clock (known once they write). */
function setUpDefaults(defaults: Defaults | undefined, agent: AgentIO): void {
  if (!defaults || !agent.chats().find((c) => c.id === agent.chat)?.main) return;
  const done = defaults.setUp();
  // the ones set up already follow this version's wording (a title the user cannot change finds them)
  for (const d of defaults.schedules) if (done.includes(d.key)) agent.act({ kind: "revisePreset", title: d.title, instructions: d.instructions });
  const due = defaults.schedules.filter((d) => !done.includes(d.key));
  if (due.length === 0) return;
  const { timezone } = agent.time();
  for (const d of due)
    agent.act({ kind: "schedule", title: d.title, instructions: d.instructions, when: { kind: "repeat", cron: d.cron, timezone }, needs: d.needs, preset: true });
  defaults.markSetUp([...done, ...due.map((d) => d.key)]);
}

/**
 * The user's skills now, against `before` (null: the first look, which tells nothing): what to tell the
 * agent about the new and changed ones, and what it has seen now.
 */
export function skillsSince(before: Map<string, string> | null, every: Skill[]): { seen: Map<string, string>; news: string } {
  const mine = every.filter((s) => s.from !== "built in");
  const seen = new Map(mine.map((s) => [s.name, `${s.description}\n${s.body}`]));
  if (before === null) return { seen, news: "" };
  const lines = mine.filter((s) => before.get(s.name) !== seen.get(s.name)).map((s) => `- ${s.name} (${before.has(s.name) ? "changed" : "new"}): ${s.description}`);
  const news =
    lines.length === 0
      ? ""
      : [
          "Skills new or changed since your last turn (installed in your sandbox, or written there or by you):",
          ...lines,
          "They change how you work, so tell the user in a short line each what it is for, and that they can remove it in Skills in the sidebar, unless you already told them.",
        ].join("\n");
  return { seen, news };
}

/** Development: every tool call and what came back, on the server's console (they may hold the user's data: never on in production). */
const debugTools = process.env["AMUSE_DEBUG_TOOLS"] === "1";

const toolLabels: Record<string, string> = {
  browse: "Starting a browser task",
  read_browser: "Looking at the browser",
  request_connection: "Preparing a connection",
  app_tools: "Looking up your connections",
  app_call: "Using your connections",
  list_files: "Looking through files",
  read_file: "Looking at a file",
  write_file: "Writing a file",
  move_file: "Moving a file",
  delete_file: "Deleting a file",
  send_file: "Sending you a file",
  run_command: "Running a command",
  job_output: "Looking at a background job",
  stop_job: "Stopping a background job",
  schedule: "Scheduling",
  start_task: "Handing off a task",
  cancel_schedule: "Cancelling a schedule",
  message_run: "Telling a background task",
  answer_question: "Passing on your answer",
  stop_run: "Stopping a background task",
  no_reply: "Wrapping up",
  say: "Writing to you",
  suggest_replies: "Writing to you",
};

type Message = Extract<Turn, { kind: "message" }>;

/** A message of the user's sent while a turn was running: what the model is given of it (`sent`), and the turn to run for it if it is never read. */
interface Steered {
  turn: Message;
  sent: string;
}

/** The turn the model is working on, open to what the user adds meanwhile. */
interface Steering {
  session: AgentSession;
  /** the messages sent meanwhile that the model has not read (they are in the chat already) */
  unread: Steered[];
  /** the messages go in one after another, in the order sent */
  sending: Promise<void>;
}

/**
 * The next run of a chat's lane, after the ones before it. One that fails does not stop the lane, the other lanes or the server (a
 * rejection nobody handles ends the process): it is said in the log, in words, and the run after it goes on.
 */
export function continued(queue: Promise<void>, chat: string, next: () => Promise<void>, log: (message: string) => void = console.error): Promise<void> {
  return queue.then(next).catch((error: unknown) => {
    log(`amuse: a turn in the chat ${chat} ended with an error and was dropped: ${error instanceof Error ? error.message : String(error)}`);
  });
}

/** One chat's agent: its runs one after another, the session of the one in progress, and its interrupt count. */
interface Lane {
  queue: Promise<void>;
  session: PiSession | undefined;
  /** While the model works on a turn: what the user sends meanwhile goes to it. */
  steering: Steering | undefined;
  /**
   * The user's messages no turn has taken yet (they are in the chat already). A turn starting takes them all, being given the chat
   * as it stands; a turn queued for one of them that finds none left has nothing to do.
   */
  owed: Message[];
  /** What it must read with its next turn, never a turn of its own: a browser taken over, or handed back. */
  kept: string[];
  /** Bumped by interrupt: the run in progress says nothing more. Queued prompts and reports still run. */
  epoch: number;
}

/**
 * prompt + interrupt + title on Pi. Each chat's prompts run one after another;
 * chats run side by side; interrupt aborts the chat's current run.
 */
export function piAgent(cfg: PiConfig): Pick<Ports, "prompt" | "interrupt" | "title"> {
  const lanes = new Map<string, Lane>();
  // the user's skills as the agent last saw them, by name: what is new or changed since gets told (null: not looked yet)
  let skillsSeen: Map<string, string> | null = null;
  // the commands that went on in the background, by chat
  const jobs = cfg.sandbox ? jobBook(cfg.sandbox) : undefined;
  const skillNews = (every: Skill[]): string => {
    const { seen, news } = skillsSince(skillsSeen, every);
    skillsSeen = seen;
    return news;
  };
  const laneOf = (chat: string): Lane => {
    const lane = lanes.get(chat) ?? { queue: Promise.resolve(), session: undefined, steering: undefined, owed: [], kept: [], epoch: 0 };
    lanes.set(chat, lane);
    return lane;
  };

  const enqueue = (lane: Lane, chat: string, next: () => Promise<void>) => {
    lane.queue = continued(lane.queue, chat, next);
  };

  const run = async (turn: Turn, agent: AgentIO, lane: Lane): Promise<void> => {
    // the user's messages this turn answers: those waiting, and any that come while it sets up
    const taken = lane.owed.splice(0);
    if (turn.kind === "message" && taken.length === 0) return;
    const mine = lane.epoch;
    const live = () => mine === lane.epoch;
    const emit: AgentIO["emit"] = (say) => {
      if (live()) agent.emit(say);
    };
    /** the user has written and not been answered in this turn yet */
    let heard = false;
    /** the messages the model read mid-turn, since it last replied (they are answered when it does) */
    const read: Message[] = [];
    /** whether it read any mid-turn at all */
    let readAny = false;
    /** the turn failed (and the user was told) */
    let failed = false;
    /** tools act through this run's chat; a file sent on its own is an answer too */
    const here: AgentIO = {
      ...agent,
      emit: (say) => {
        if (!blank(say) && say.kind === "upserted" && say.entity.kind === "reply") {
          heard = false;
          read.length = 0;
        }
        agent.emit(say.kind === "upserted" && say.entity.kind === "reply" ? { ...say, entity: withOffer(say.entity) } : say);
      },
    };
    const io = () => here;
    /** options to tap, offered with `suggest_replies`, for the next reply shown */
    let offered: string[] = [];
    /** a reply as it is shown: with the options offered for it, once */
    const withOffer = (entity: Reply): Reply => {
      if (offered.length === 0 || !entity.text.trim()) return entity;
      const suggestions = offered;
      offered = [];
      return { ...entity, suggestions };
    };
    emit({ kind: "activity", activity: { kind: "responding", label: null } });
    /** what the model is writing in its current message */
    let said = "";
    /** the model chose to say nothing this turn: whatever it writes is dropped */
    let silent = false;
    try {
      // the user's language, said where the model weighs it most: the end of the turn's message, beside what to do
      const language = scriptOf(agent.lastWords());
      // the skills there are now (the user may have added one), a line each
      const every = await allSkills(cfg.skills ?? [], cfg.files);
      const skills = catalog(every);
      const news = turn.kind === "message" ? skillNews(every) : "";
      // what is the same from turn to turn comes first, so the provider can reuse it: the rules, then the skills
      const system = [cfg.system, skills].filter(Boolean).join("\n\n");
      if (turn.kind === "message") setUpDefaults(cfg.defaults, agent);
      // a note from background work may end with nothing to say; a turn the user started always has an answer to give
      const background = turn.kind !== "message";
      const toolset = agentTools(cfg, io, () => heard, () => (silent = true), (options) => (offered = options), background, jobs);
      // many calls in one turn, only what the script returns in its context
      // the chat has one cache name, and the turn's message begins with what the last one did: both let a provider find its cache again
      let stable: string[] = [];
      const caching: Caching = { key: `amuse-${agent.chat}`, stable: () => stable };
      const session = await (cfg.open ? cfg.open(system, toolset, caching) : openSession(cfg, system, toolset, { codemode: true, caching }));
      lane.session = session;
      const pi = session.session;
      if (!live()) return;
      let failure: string | undefined;
      const unsubscribe = pi.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          said += event.assistantMessageEvent.delta;
        } else if (event.type === "tool_execution_start") {
          if (debugTools) console.log(`[tool] ${event.toolName} ${JSON.stringify(event.args).slice(0, 600)}`);
          // the line under the avatar says what the agent is doing, Muse-style
          emit({ kind: "activity", activity: { kind: "working", label: statusOf(event.args) ?? toolLabels[event.toolName] ?? "Working" } });
        } else if (event.type === "tool_execution_end") {
          if (debugTools) console.log(`[tool] ${event.toolName}${event.isError ? " (error)" : ""}: ${JSON.stringify(event.result).slice(0, 600)}`);
          emit({ kind: "activity", activity: { kind: "responding", label: null } });
        } else if (event.type === "message_start" && event.message.role === "user") {
          // a message of the user's reaches the model mid-turn (the brief, the first, is no steered one)
          const text = textOf(event.message.content);
          const at = lane.steering?.unread.findIndex((m) => m.sent === text) ?? -1;
          const [steered] = at >= 0 ? (lane.steering?.unread.splice(at, 1) ?? []) : [];
          if (steered) {
            // what the model decided about the turn before was about the turn before; the user is to be answered
            silent = false;
            heard = true;
            readAny = true;
            read.push(steered.turn);
          }
        } else if (event.type === "message_end" && event.message.role === "assistant") {
          // only what the agent says once it is done is its reply; what it writes on the way to a tool
          // is its own thinking aloud (often in another language), and the status line already says what it does
          const { stopReason } = event.message;
          const text = said.trim();
          said = "";
          // the model sometimes writes the word instead of calling the tool: in a turn nobody is waiting on, a reply that is
          // only that is no reply. A turn the user wrote to keeps it: there it is something to say, not a tool to call
          const onlyName = background && !heard && /^(?:[\s\S]*<\/think>)?\s*`?no_reply`?\.?\s*$/i.test(text);
          if (stopReason === "error") failure = event.message.errorMessage ?? "The model run failed";
          else if (text && !silent && !onlyName && stopReason !== "toolUse" && stopReason !== "aborted") {
            heard = false;
            read.length = 0;
            emit({ kind: "upserted", entity: withOffer({ kind: "reply", id: newId("r"), at: new Date().toISOString(), text, streaming: false, attachments: [], suggestions: [], chosen: null }) });
          }
        } else if (event.type === "auto_retry_end" && event.success) {
          // the model's service failed and then answered: the failure is no longer one
          failure = undefined;
        }
      });
      try {
        // the images the user just sent are seen with their message
        const shown = cfg.files ? await images(cfg.files, taken.flatMap((m) => m.attachments)) : [];
        const remembered = [cfg.files ? await memoryBrief(cfg.files).catch(() => "") : "", news].filter(Boolean).join("\n\n");
        // what the user sent while this was set up is in the chat the model is given now
        for (let more = lane.owed.splice(0); more.length > 0; more = lane.owed.splice(0)) {
          taken.push(...more);
          if (cfg.files) shown.push(...(await images(cfg.files, more.flatMap((m) => m.attachments))));
        }
        heard = taken.length > 0;
        const told = brief(jobs ? { ...agent, running: () => withJobs(agent.running(), jobs.running(agent.chat), agent.time().now) } : agent, turn, remembered, heard, language, lane.kept.splice(0).join("\n\n"));
        stable = told.stable;
        // from here the model has the conversation as it stands: what the user adds goes to it as it works
        lane.steering = { session: pi, unread: [], sending: Promise.resolve() };
        await pi.prompt(told.text, { expandPromptTemplates: false, ...(shown.length > 0 ? { images: shown } : {}) });
      } finally {
        unsubscribe();
      }
      if (failure !== undefined) throw new Error(failure);
    } catch (error) {
      if (!live()) return;
      failed = true;
      const detail = redact(error instanceof Error ? error.message : String(error), secretsOf(cfg));
      // not something Muse said: a failure of its own kind, with the turn kept to try again
      emit({
        kind: "upserted",
        entity: {
          kind: "failure",
          id: newId("x"),
          at: new Date().toISOString(),
          reason: /content_filter|content filter|safety/i.test(detail) ? "refused" : "failed",
          detail,
          // a note turn that took in or read the user's messages is retried for them
          turn: turn.kind === "message" || taken.length > 0 || readAny ? { kind: "message" } : { kind: "note", text: turn.text },
          status: "open",
        },
      });
    } finally {
      // the turn is over. The user's messages the model never read are owed a turn: of their own if it ended first or was stopped, and
      // if it failed, the user's Retry (or their next message) takes them, rather than a turn that would fail the same way beside the card.
      // Stopped, it still answers what the user said last: the messages it read but did not answer too (not what it took when it began).
      const unread = lane.steering?.unread.splice(0).map((m) => m.turn) ?? [];
      lane.steering = undefined;
      const owing = live() ? unread : [...read, ...unread];
      const last = owing.at(-1);
      if (last) {
        lane.owed.push(...owing);
        if (!failed) enqueue(lane, agent.chat, () => run(last, agent, lane));
      }
      lane.session?.close();
      lane.session = undefined;
      emit({ kind: "activity", activity: null });
    }
  };

  return {
    prompt: (turn, agent) => {
      const lane = laneOf(agent.chat);
      const queued = () => {
        if (turn.kind === "message") lane.owed.push(turn);
        enqueue(lane, agent.chat, () => run(turn, agent, lane));
      };
      // a message from the user while the model is working on a turn of this chat goes to it as it works; otherwise it is the next turn
      if (turn.kind === "message" && lane.steering) steer(lane.steering, turn, cfg.files, queued);
      // a note that must not wake the agent: with the turn under way, or kept for the next one
      else if (turn.kind === "aside") aside(lane, turn.text);
      else queued();
    },
    interrupt: (agent) => {
      const lane = laneOf(agent.chat);
      jobs?.stopChat(agent.chat);
      lane.epoch++;
      void lane.session?.session.abort().catch(() => {});
    },
    title: (text) => title(cfg, text),
  };
}

/**
 * The chat agent's tools, always in this order and with these schemas for the same setup (a provider caches a request by what it
 * starts with, and the tools come before the conversation): nothing here is sorted, shuffled or made up of the turn, but one
 * thing: `background` is whether the turn is a note from background work, and only such a turn has `no_reply` at all.
 */
export function agentTools(cfg: PiConfig, io: () => AgentIO, heard: () => boolean, silence: () => void, offer: (options: string[]) => void, background = true, jobs: JobBook | undefined = cfg.sandbox ? jobBook(cfg.sandbox) : undefined): ToolDefinition[] {
  return [
    // with memory, memory_search looks in the chats as recall did, and in memory/ too
    ...tools(io, cfg.rules, { files: cfg.files, appsSetup: cfg.appsSetup, appsFit: cfg.appsFit }).filter((t) => !(cfg.files && t.name === "recall")),
    ...(cfg.browsers ? browserReadTools(cfg, cfg.browsers, cfg.files) : []),
    ...(cfg.files ? [...memoryReadTools(io, cfg.files), ...memoryWriteTools(io, cfg.files)] : []),
    ...skillTools(cfg.skills ?? [], cfg.files),
    ...(cfg.about ? aboutTools(cfg.about) : []),
    ...chatTools(io),
    ...scheduleTools(io, cfg.files),
    ...taskTools(io),
    ...relayTools(io),
    ...webTools(io, cfg.rules, cfg.search),
    ...(cfg.apps ? appTools(io, cfg.apps) : []),
    ...(cfg.files ? workspaceTools(io, cfg.files) : []),
    ...(jobs ? jobs.tools(io) : []),
    ...(cfg.secrets ? secretTools(io, { ...cfg.secrets, sandbox: cfg.sandbox !== undefined }) : []),
    ...sayTools(io),
    ...(background ? silenceTools(heard, silence) : []),
    ...suggestTools(offer),
  ];
}

/**
 * The user's message to a turn in progress, as the model reads it among its own steps: said to be new, with its files (images
 * are seen). If it cannot be given, `otherwise` makes it a turn of its own.
 */
function steer(steering: Steering, turn: Message, files: Workspace | undefined, otherwise: () => void): void {
  const names = attached(turn.attachments);
  const sent = [
    turn.suggested ? "The user, while you were working (they tapped one of your suggested replies):" : "The user, while you were working:",
    turn.quote ? `(replying to ${quoted(turn.quote)})` : "",
    turn.text,
    names ? `Attached: ${names}` : "",
    "(If you have more to do before your reply, answer them now with `say`, briefly, then go on.)",
  ]
    .filter(Boolean)
    .join("\n");
  const message: Steered = { turn, sent };
  // from now on the end of the turn finds it, if the model never reads it
  steering.unread.push(message);
  steering.sending = steering.sending.then(async () => {
    try {
      const shown = files ? await images(files, turn.attachments) : [];
      await steering.session.steer(sent, shown.length > 0 ? shown : undefined);
    } catch {
      const at = steering.unread.indexOf(message);
      // not found: the turn ended meanwhile and has taken it on
      if (at < 0) return;
      steering.unread.splice(at, 1);
      otherwise();
    }
  });
}

/**
 * A note that must not wake the agent (a browser taken over, or handed back): it reaches the turn under way as
 * it works, and is kept for the next one when there is none. It is never a turn of its own: the work it tells
 * about carries on by itself.
 */
function aside(lane: Lane, text: string): void {
  const steering = lane.steering;
  if (!steering) {
    lane.kept.push(text);
    return;
  }
  steering.sending = steering.sending.then(async () => {
    try {
      await steering.session.steer(`While you were working, from your background work (not the user):\n${text}`);
    } catch {
      // the turn ended meanwhile: the next one reads it
      lane.kept.push(text);
    }
  });
}

/** The text of a message's content. */
const textOf = (content: string | ({ type: string; text?: string })[]): string => (typeof content === "string" ? content : content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join(""));

/** A few words naming a chat after its first message, in that message's language. */
async function title(cfg: PiModelConfig, text: string): Promise<string> {
  const session = await openSession(cfg, "You name chats. Reply with a title of two to five words for a chat that starts with the user's message, in the language of the message. The title only: no quotes, no punctuation at the end.", []);
  try {
    let named = "";
    const unsubscribe = session.session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") named += event.assistantMessageEvent.delta;
    });
    try {
      await session.session.prompt(text.slice(0, 2_000), { expandPromptTemplates: false });
    } finally {
      unsubscribe();
    }
    return named.trim().split("\n")[0] ?? "";
  } finally {
    session.close();
  }
}

/**
 * The language the user writes in, where its script tells it (a model slips into English
 * after reading English pages, or answering a message full of URLs): Chinese, Japanese,
 * Korean. Null for scripts that do not tell (the model goes by the message).
 */
export function scriptOf(text: string): Language | null {
  const plain = text.replace(/https?:\/\/\S+/g, "");
  if (scripts.Japanese.test(plain)) return "Japanese";
  if (scripts.Korean.test(plain)) return "Korean";
  if (scripts.Chinese.test(plain)) return "Chinese";
  return null;
}

type Language = "Chinese" | "Japanese" | "Korean";
/** Characters only that language's script has (Japanese kana; Korean hangul; Chinese, then, han). */
const scripts: Record<Language, RegExp> = { Japanese: /[\u3040-\u30ff]/, Korean: /[\uac00-\ud7af]/, Chinese: /[\u4e00-\u9fff]/ };

/** The turn's message: all of it, and the first part of it that stays as it is from turn to turn (cut at its lines: cache.ts). */
export interface Brief {
  text: string;
  stable: string[];
}

/**
 * The turn as the model gets it, by how much each part changes. First what holds still: the heading, then the conversation, which only
 * grows at its end (context.ts) and is cached by the provider up to where it last agreed. Last what is new every turn: where this
 * is, what is running now (live.ts) and what happened while it was not looking, what is remembered, the language, the time, and what
 * to do.
 */
export function brief(agent: Pick<AgentIO, "chat" | "chats" | "context" | "time" | "running">, turn: Turn, remembered: string, written: boolean, language: string | null, kept: string): Brief {
  const { now, timezone } = agent.time();
  const here = agent.chats().find((c) => c.id === agent.chat);
  const where = here?.main
    ? "You are in the main chat."
    : `You are in a side chat${here?.title ? ` ("${here.title}")` : ""}: only this chat is shown above. The main chat and other chats are there to look up (list_chats, read_chat, recall with everywhere) when the user refers to them.`;
  const task =
    turn.kind === "message"
      ? "Reply to the user's newest message (the last lines above)."
      : `A note from your background work (not from the user). Tell the user only what they need to hear, in your own words, never that a note came. If nothing needs them (all is well, nothing was waiting, you already told them), call no_reply and write nothing: never explain why you are staying silent.${written ? " The user has also written since (their newest message is in the last lines above): reply to them too." : ""}\n${turn.text}`;
  const speaks = language ? `The user writes in ${language}: reply in ${language}.` : "";
  const since = kept ? `Since your last turn:\n${kept}` : "";
  const prefix = `The conversation so far, oldest first (times are the user's, ${timezone}):\n\n${agent.context()}\n`;
  const tail = `\n---\n${[where, agent.running(), since, remembered, speaks].filter(Boolean).join("\n\n")}\n\nNow: ${nowIn(now, timezone)}.\n${task}`;
  return { text: prefix + tail, stable: closedParts(prefix) };
}
