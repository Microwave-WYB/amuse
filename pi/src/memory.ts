/**
 * Amuse's memory: Markdown files in the workspace, under memory/, which the
 * user can read and change too. In layers:
 *   USER.md              who the user is: name, time zone, background (the most stable)
 *   MEMORY.md            what is true now, kept short: Facts, Preferences, Commitments; a newer
 *                        conclusion replaces an older one. Each line ends with its id (m-…).
 *   journal/<date>.md    the record: every memory's source (who said it, when, in what words),
 *                        and what it replaced. MEMORY.md keeps conclusions; the journal, evidence.
 *   people/, groups/     a page each for the people and groups around the user, and an INDEX.md
 *                        of them, closest first
 *   dreams/              a reflection a night, and ALIGNMENT.md: how to work with the user now
 *   goals/               a folder a goal the user is working toward (core goals.ts)
 * USER.md, MEMORY.md, ALIGNMENT.md and the active goals' titles go with every turn; the rest is looked up (memory_search,
 * memory_get, memory_explain). The chat agent remembers with `remember`, keeping the record; it
 * forgets only what the user confirms on a card. Background runs keep the files with the
 * workspace tools, by the same rules.
 */
import { type ToolDefinition, defineTool } from "@earendil-works/pi-coding-agent";
import { type AgentIO, GOALS, type Workspace, listGoals, localTime } from "@amuse/core";
import { Type } from "typebox";
import { status } from "./status.ts";

export const MEMORY = "memory";
const USER = `${MEMORY}/USER.md`;
const FILE = `${MEMORY}/MEMORY.md`;
const ALIGNMENT = `${MEMORY}/dreams/ALIGNMENT.md`;
const journalOf = (day: string) => `${MEMORY}/journal/${day}.md`;

/** MEMORY.md's sections, in order. */
const SECTIONS = ["Facts", "Preferences", "Commitments"];
/** Which sections of MEMORY.md go first in the turn's brief so a long Facts section never crowds them out. */
const PRIORITY = ["Preferences", "Commitments"];
const START = ["# Memory", "", "What is true now about the user. Each line ends with its id; its record is in journal/.", "", ...SECTIONS.flatMap((s) => [`## ${s}`, ""])].join("\n");

/** How much of a file goes with every turn. */
const BRIEF_LIMIT = 6_000;

type Text = { content: { type: "text"; text: string }[]; details: null };
const text = (value: string): Text => ({ content: [{ type: "text", text: value }], details: null });
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… (cut; read the rest with memory_get)` : s);

/**
 * MEMORY.md for a turn's brief: `## Preferences` and `## Commitments` first, then `## Facts` and any other sections in what
 * room remains of `limit`, so a long list of facts never pushes the user's preferences or open commitments out of sight.
 */
export function briefMemory(content: string, limit = BRIEF_LIMIT): string {
  const trimmed = content.trim();
  const blocks = trimmed.split(/\n(?=## )/);
  const parsed = blocks.flatMap((block) => {
    const match = block.match(/^## ([^\n]+)\n?([\s\S]*)$/);
    return match && match[2]?.trim() ? [{ title: match[1]!.trim(), body: match[2].trim() }] : [];
  });
  if (parsed.length === 0) return clip(trimmed, limit);
  const rank = (title: string) => {
    const at = PRIORITY.indexOf(title);
    return at >= 0 ? at : PRIORITY.length;
  };
  const ordered = [...parsed].sort((a, b) => rank(a.title) - rank(b.title));
  let remaining = limit;
  return ordered
    .map((section, i) => {
      const after = ordered.length - 1 - i;
      const share = after > 0 ? Math.max(1_500, remaining - after * 1_500) : Math.max(500, remaining);
      const body = clip(section.body, share);
      const rendered = `## ${section.title}\n${body}`;
      remaining = Math.max(0, remaining - rendered.length);
      return rendered;
    })
    .join("\n\n");
}

async function read(files: Workspace, path: string): Promise<string | null> {
  if (!(await files.exists(path))) return null;
  return new TextDecoder().decode((await files.open(path)).data);
}
const write = (files: Workspace, path: string, content: string) => files.write(path, new TextEncoder().encode(content), true);

/** Every Markdown file under memory/. */
async function every(files: Workspace, folder = MEMORY): Promise<string[]> {
  if (!(await files.exists(folder))) return [];
  const entries = await files.list(folder);
  const nested = await Promise.all(entries.filter((e) => e.kind === "folder").map((e) => every(files, e.path)));
  return [...entries.filter((e) => e.kind === "file" && e.path.endsWith(".md")).map((e) => e.path), ...nested.flat()];
}

/** What goes with every turn: who the user is, what is true now, and how to work with them. Empty before there is any. */
export async function memoryBrief(files: Workspace): Promise<string> {
  const parts = await Promise.all(
    [
      [USER, "Who the user is"],
      [FILE, "What is true now"],
      [ALIGNMENT, "How to work with the user now (from your nightly reflection)"],
    ].map(async ([path, title]) => {
      const content = path ? await read(files, path).catch(() => null) : null;
      if (!content?.trim()) return null;
      const body = path === FILE ? briefMemory(content, BRIEF_LIMIT) : clip(content.trim(), BRIEF_LIMIT);
      return `## ${title} (${path})\n${body}`;
    }),
  );
  const goals = (await listGoals(files).catch(() => [])).filter((g) => g.status === "active");
  const working =
    goals.length === 0
      ? null
      : [
          `## What the user is working toward (${GOALS}/; the goals skill says how to help)`,
          ...goals.map(
            (g) => `- ${g.title} (${GOALS}/${g.id}/)${g.muted ? ", muted: do not bring it up unasked" : ""}${g.latest ? `, last moved ${g.latest.day}` : ""}`,
          ),
        ].join("\n");
  const shown = [...parts, working].filter((p) => p !== null);
  return shown.length === 0 ? "" : `Your memory of the user (the files are yours to keep current):\n\n${shown.join("\n\n")}`;
}

/** Lines of the memory files with as many of `query`'s words as can be found, best first. */
export async function search(files: Workspace, query: string, limit = 20): Promise<string[]> {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (words.length === 0) return [];
  const hits: { line: string; score: number }[] = [];
  for (const path of await every(files)) {
    const content = await read(files, path).catch(() => null);
    content?.split("\n").forEach((line, i) => {
      const low = line.toLowerCase();
      const score = words.filter((w) => low.includes(w)).length;
      if (score > 0 && line.trim()) hits.push({ line: `${path}:${i + 1}: ${line.trim()}`, score });
    });
  }
  return hits
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((h) => h.line);
}

const newId = () => `m-${crypto.randomUUID().slice(0, 6)}`;

/** Changes to a workspace's memory, one at a time: each reads a file and writes it back, and two at once would lose one. */
const queues = new WeakMap<Workspace, Promise<unknown>>();
function oneAtATime<T>(files: Workspace, change: () => Promise<T>): Promise<T> {
  const next = (queues.get(files) ?? Promise.resolve()).then(change);
  queues.set(files, next.catch(() => {}));
  return next;
}

/** Add `line` under `section` of MEMORY.md (made if missing), taking out the line `replaces` names; what was taken out. */
export function remember(
  files: Workspace,
  io: Pick<AgentIO, "time">,
  entry: { section: string; text: string; source: string; replaces?: string | undefined },
): Promise<{ id: string; replaced: string | null }> {
  return oneAtATime(files, () => rememberNow(files, io, entry));
}

async function rememberNow(
  files: Workspace,
  io: Pick<AgentIO, "time">,
  entry: { section: string; text: string; source: string; replaces?: string | undefined },
): Promise<{ id: string; replaced: string | null }> {
  const id = newId();
  const target = entry.section === "User" ? USER : FILE;
  let lines = ((await read(files, target)) ?? (target === FILE ? START : "# About the user\n")).split("\n");
  let replaced: string | null = null;
  if (entry.replaces?.trim()) {
    const what = entry.replaces.trim().toLowerCase();
    const at = lines.findIndex((l) => l.startsWith("- ") && l.toLowerCase().includes(what));
    if (at >= 0) {
      replaced = lines[at] ?? null;
      lines = lines.filter((_, i) => i !== at);
    }
  }
  const line = `- ${entry.text.trim().replace(/\s+/g, " ")} (${id})`;
  if (target === FILE) {
    const heading = lines.findIndex((l) => l.trim() === `## ${entry.section}`);
    if (heading < 0) lines.push(`## ${entry.section}`, line);
    else {
      // at the end of the section
      let end = heading + 1;
      while (end < lines.length && !lines[end]?.startsWith("## ")) end++;
      while (end > heading + 1 && !lines[end - 1]?.trim()) end--;
      lines.splice(end, 0, line);
    }
  } else lines.push(line);
  await write(files, target, lines.join("\n").replace(/\n*$/, "\n"));
  await record(files, io, [`${id} remembered (${entry.section})`, entry.text.trim(), `Source: ${entry.source.trim()}`, ...(replaced ? [`Replaces: ${replaced.replace(/^- /, "")}`] : [])]);
  return { id, replaced };
}

/** Append an entry to today's journal (the user's day). */
async function record(files: Workspace, io: Pick<AgentIO, "time">, lines: string[]): Promise<void> {
  const { now, timezone } = io.time();
  const [day, time] = localTime(now, timezone).split(" ");
  const path = journalOf(day ?? "today");
  const before = (await read(files, path)) ?? `# ${day}\n`;
  await write(files, path, `${before.replace(/\n*$/, "\n")}\n## ${time} · ${lines[0]}\n${lines.slice(1).join("\n")}\n`);
}

/** The lines of USER.md and MEMORY.md that hold `what` (an id, or words of it). */
async function matching(files: Workspace, what: string): Promise<{ path: string; line: string }[]> {
  const low = what.trim().toLowerCase();
  if (!low) return [];
  const found: { path: string; line: string }[] = [];
  for (const path of [USER, FILE]) {
    const content = await read(files, path);
    for (const line of content?.split("\n") ?? []) if (line.startsWith("- ") && line.toLowerCase().includes(low)) found.push({ path, line });
  }
  return found;
}

/** Take `lines` out of their files, and say so in the journal. */
export function forget(files: Workspace, io: Pick<AgentIO, "time">, lines: { path: string; line: string }[], why: string): Promise<void> {
  return oneAtATime(files, () => forgetNow(files, io, lines, why));
}

async function forgetNow(files: Workspace, io: Pick<AgentIO, "time">, lines: { path: string; line: string }[], why: string): Promise<void> {
  for (const path of new Set(lines.map((l) => l.path))) {
    const gone = new Set(lines.filter((l) => l.path === path).map((l) => l.line));
    const content = (await read(files, path)) ?? "";
    await write(files, path, content
      .split("\n")
      .filter((l) => !gone.has(l))
      .join("\n"));
  }
  await record(files, io, ["forgotten, as the user confirmed", ...lines.map((l) => l.line.replace(/^- /, "")), `Why: ${why}`]);
}

/** Looking things up in memory: for every agent. */
export function memoryReadTools(io: () => AgentIO, files: Workspace): ToolDefinition[] {
  return [
    defineTool({
      name: "memory_search",
      label: "Look in memory",
      description:
        "Search everything you remember and every chat: memory/ (MEMORY.md, USER.md, the dated journal, people and group pages, reflections) and what was said in the chats. Gives matching lines with where they are (file and line). Use it when the user refers to earlier chats or details not in the turn's memory brief.",
      parameters: Type.Object({ status, query: Type.String({ description: "A few words to find" }) }),
      async execute(_, { query }) {
        const lines = await search(files, query);
        const said = io().recall(query, true);
        return text([lines.length > 0 ? `In memory:\n${lines.join("\n")}` : "Nothing in memory/ mentions that.", `In the chats:\n${said}`].join("\n\n"));
      },
    }),
    defineTool({
      name: "memory_get",
      label: "Read from memory",
      description: "Read a memory file, or lines of it (as memory_search points to them), to see the whole of it before relying on a summary.",
      parameters: Type.Object({
        status,
        path: Type.String({ description: "e.g. memory/MEMORY.md, memory/journal/2026-10-21.md, memory/people/Yue.md" }),
        from: Type.Optional(Type.Number({ description: "First line (1-based)" })),
        to: Type.Optional(Type.Number({ description: "Last line" })),
      }),
      async execute(_, { path, from, to }) {
        if (!path.startsWith(`${MEMORY}/`)) return text(`Only files under ${MEMORY}/ are memory; read others with read_file.`);
        const content = await read(files, path).catch(() => null);
        if (content === null) return text(`There is no ${path}.`);
        const lines = content.split("\n");
        const first = Math.max(1, Math.floor(from ?? 1));
        const last = Math.min(lines.length, Math.floor(to ?? first + 199));
        return text(
          lines
            .slice(first - 1, last)
            .map((l, i) => `${first + i}: ${l}`)
            .join("\n") + (last < lines.length ? `\n… (${lines.length - last} more lines)` : ""),
        );
      },
    }),
    defineTool({
      name: "memory_explain",
      label: "Trace a memory",
      description: "Where a memory came from: who said it, when, in what words, and what it replaced, from the journal. For when the user asks how you know something, or corrects it.",
      parameters: Type.Object({ status, memory: Type.String({ description: "Its id (m-…) or words of it" }) }),
      async execute(_, { memory }) {
        const held = await matching(files, memory);
        const id = memory.trim().match(/^m-[0-9a-f]+$/)?.[0] ?? held[0]?.line.match(/\((m-[0-9a-f]+)\)\s*$/)?.[1];
        if (!id) return text(held.length > 0 ? `Found, but without an id to trace:\n${held.map((h) => h.line).join("\n")}` : `Nothing in memory holds "${memory}".`);
        const records: string[] = [];
        for (const path of (await every(files, `${MEMORY}/journal`)).sort()) {
          const content = (await read(files, path)) ?? "";
          for (const entry of content.split(/\n(?=## )/)) if (entry.includes(id)) records.push(`${path}\n${entry.trim()}`);
        }
        const now = held.find((h) => h.line.includes(id));
        return text([now ? `Now: ${now.line} (${now.path})` : `${id} is no longer in memory.`, records.length > 0 ? records.join("\n\n") : "No record of it in the journal."].join("\n\n"));
      },
    }),
  ];
}

/** Keeping memory: the chat agent's (background runs keep the files themselves). */
export function memoryWriteTools(io: () => AgentIO, files: Workspace): ToolDefinition[] {
  return [
    defineTool({
      name: "remember",
      label: "Remember",
      description:
        "Keep something about the user for good, when it will matter later: a fact, a preference, a commitment (yours or theirs), or who they are (User). One short conclusion; if it changes something you remembered, name that in `replaces` so the old one goes. The source is recorded in the journal.",
      parameters: Type.Object({
        status,
        section: Type.Union([Type.Literal("User"), Type.Literal("Facts"), Type.Literal("Preferences"), Type.Literal("Commitments")]),
        text: Type.String({ description: "The conclusion, in one line, in the user's language" }),
        source: Type.String({ description: "Where it comes from: who said it, where, in their words (a short quote)" }),
        replaces: Type.Optional(Type.String({ description: "The id (m-…) or words of what this replaces" })),
      }),
      async execute(_, { section, text: line, source, replaces }) {
        const { id, replaced } = await remember(files, io(), { section, text: line, source, replaces });
        return text(`Remembered (${id}).${replaced ? ` It replaces: ${replaced.replace(/^- /, "")}` : replaces ? ` Nothing matched "${replaces}" to replace.` : ""}`);
      },
    }),
    defineTool({
      name: "forget",
      label: "Forget",
      description:
        "Forget something you remember, when the user asks: what matches is shown to them on a card, and goes only once they confirm. Returns at once; you hear how it went.",
      parameters: Type.Object({
        status,
        memory: Type.String({ description: "Its id (m-…) or words of it" }),
        why: Type.String({ description: "Why, in the user's words" }),
      }),
      async execute(_, { memory, why }) {
        const lines = await matching(files, memory);
        if (lines.length === 0) return text(`Nothing in memory holds "${memory}". Look with memory_search.`);
        const agent = io();
        const asked = agent.act({ kind: "ask", action: "Forget", target: "Memory", detail: `${why}\n\n${lines.map((l) => l.line.replace(/^- /, "")).join("\n")}`, remember: false });
        if (!asked.ok) return text("Could not ask the user.");
        void agent.decision(asked.id).then(async ({ verdict }) => {
          if (verdict !== "approved") return agent.report(`[memory] Not forgotten: the user ${verdict === "denied" ? "kept it" : "did not answer"}.`);
          await forget(files, agent, lines, why);
          agent.report(`[memory] Forgotten, as the user confirmed: ${lines.length} line${lines.length === 1 ? "" : "s"}.`);
        });
        return text(`NOT forgotten yet: ${lines.length} line${lines.length === 1 ? "" : "s"} wait for the user's OK on the card. Tell them.`);
      },
    }),
  ];
}

