import assert from "node:assert/strict";
import { test } from "node:test";
import { type Entry, type Workspace, addGoal, noWorkspace, updateGoal } from "@amuse/core";
import { forget, memoryBrief, remember, search } from "./memory.ts";

/** A workspace in memory: files by path, folders as their prefixes. */
function memoryWorkspace(): Workspace & { text(path: string): string | undefined } {
  const files = new Map<string, Uint8Array>();
  const decode = (data: Uint8Array) => new TextDecoder().decode(data);
  return {
    ...noWorkspace,
    exists: async (path) => files.has(path) || [...files.keys()].some((p) => p.startsWith(`${path}/`)),
    open: async (path) => {
      const data = files.get(path);
      if (!data) throw new Error(`no ${path}`);
      return { path, type: "text/markdown", size: data.length, data };
    },
    write: async (path, data) => void files.set(path, data),
    list: async (folder) => {
      const under = [...files.keys()].filter((p) => p.startsWith(`${folder}/`));
      const names = new Set(under.map((p) => p.slice(folder.length + 1).split("/")[0] ?? ""));
      return [...names].map((name): Entry => {
        const path = `${folder}/${name}`;
        const data = files.get(path);
        return { path, kind: data ? "file" : "folder", size: data?.length ?? 0, modified: "2026-10-21T00:00:00Z" };
      });
    },
    text: (path) => {
      const data = files.get(path);
      return data ? decode(data) : undefined;
    },
  };
}

const io = { time: () => ({ now: "2026-10-21T16:30:00Z", timezone: "America/Los_Angeles" }) };

test("remembering puts a conclusion under its section with an id, and keeps where it came from in the day's journal", async () => {
  const files = memoryWorkspace();
  const { id } = await remember(files, io, { section: "Preferences", text: "Prefers replies in Chinese", source: 'the user, in the main chat: "说中文"' });
  const memory = files.text("memory/MEMORY.md") ?? "";
  assert.match(memory, new RegExp(`## Preferences\\n- Prefers replies in Chinese \\(${id}\\)`));
  const journal = files.text("memory/journal/2026-10-21.md") ?? "";
  assert.match(journal, new RegExp(`## 09:30 · ${id} remembered \\(Preferences\\)`));
  assert.match(journal, /Source: the user, in the main chat: "说中文"/);
});

test("a newer conclusion replaces the older one, and the journal says what it replaced", async () => {
  const files = memoryWorkspace();
  const old = await remember(files, io, { section: "Facts", text: "Lives in San Diego", source: "the user" });
  const next = await remember(files, io, { section: "Facts", text: "Moved to Seattle", source: "the user", replaces: old.id });
  const memory = files.text("memory/MEMORY.md") ?? "";
  assert.doesNotMatch(memory, /San Diego/);
  assert.match(memory, /Moved to Seattle/);
  assert.equal(next.replaced, `- Lives in San Diego (${old.id})`);
  assert.match(files.text("memory/journal/2026-10-21.md") ?? "", /Replaces: Lives in San Diego/);
});

test("who the user is goes in USER.md; search finds lines across the memory files, best first", async () => {
  const files = memoryWorkspace();
  await remember(files, io, { section: "User", text: "Yibo, a PhD student at UCSD", source: "the user" });
  await remember(files, io, { section: "Facts", text: "Works in Aaron Schulman's lab at UCSD", source: "the user" });
  assert.match(files.text("memory/USER.md") ?? "", /Yibo, a PhD student at UCSD/);
  const found = await search(files, "Schulman lab");
  assert.match(found[0] ?? "", /^memory\/MEMORY\.md:\d+: - Works in Aaron Schulman's lab/);
  assert.deepEqual(await search(files, "nothing-like-this"), []);
});

test("every turn gets who the user is and what is true now; nothing before there is any", async () => {
  const files = memoryWorkspace();
  const empty = await memoryBrief(files);
  assert.match(empty, /## Who you are \(memory\/SOUL\.md\)\nNot written yet\./, "the page is offered before it exists");
  assert.doesNotMatch(empty, /What is true now/, "and nothing else is claimed to be known");
  // who Amuse is comes first, in its own file, and is nothing until it writes it
  await files.write("memory/SOUL.md", new TextEncoder().encode("# Who I am\n\nShort sentences, no fuss. I say what I did, not how it works."), true);
  const soul = await memoryBrief(files);
  assert.match(soul, /## Who you are, in your own words \(memory\/SOUL\.md\)/);
  assert.match(soul, /Short sentences, no fuss/, "in its own words, as written");
  assert.match(soul, /I say what I did, not how it works/);
  assert.doesNotMatch(soul, /Not written yet/, "once written, the page speaks for itself");
  await remember(files, io, { section: "Commitments", text: "Send the draft to Aaron by Friday", source: "the user" });
  const brief = await memoryBrief(files);
  assert.match(brief, /What is true now \(memory\/MEMORY\.md\)/);
  assert.ok(brief.indexOf("## Who you are") < brief.indexOf("## What is true now"), "who Amuse is comes above what is true");
  await files.write("memory/SOUL.md", new TextEncoder().encode("   "), true);
  assert.match(await memoryBrief(files), /Not written yet/, "a blank SOUL.md is the same as a missing one");
  assert.match(brief, /Send the draft to Aaron by Friday/);
  await addGoal(files, { title: "Learn Japanese", about: "" }, "2026-10-21");
  const closing = await addGoal(files, { title: "Move to Seattle", about: "" }, "2026-10-21");
  await updateGoal(files, closing.id, { status: "done" }, "2026-10-22");
  const quiet = await addGoal(files, { title: "Gain weight", about: "" }, "2026-10-21");
  await updateGoal(files, quiet.id, { muted: true }, "2026-10-22");
  const withGoals = await memoryBrief(files);
  assert.match(withGoals, /- Learn Japanese \(memory\/goals\/learn-japanese\/\)/);
  assert.doesNotMatch(withGoals, /Seattle/, "only the goals still worked on");
  assert.match(withGoals, /- Gain weight \(memory\/goals\/gain-weight\/\), muted: do not bring it up unasked/);
});

test("forgetting takes the lines out and records it", async () => {
  const files = memoryWorkspace();
  const { id } = await remember(files, io, { section: "Facts", text: "Has a cat named Mochi", source: "the user" });
  await forget(files, io, [{ path: "memory/MEMORY.md", line: `- Has a cat named Mochi (${id})` }], "the user asked");
  assert.doesNotMatch(files.text("memory/MEMORY.md") ?? "", /Mochi/);
  assert.match(files.text("memory/journal/2026-10-21.md") ?? "", /forgotten, as the user confirmed\nHas a cat named Mochi/);
});

test("things remembered at the same moment are all kept, each with its record", async () => {
  const files = memoryWorkspace();
  const ids = await Promise.all([
    remember(files, io, { section: "User", text: "Xiaoming", source: "the user" }),
    remember(files, io, { section: "Preferences", text: "Only drinks iced Americano", source: "the user" }),
    remember(files, io, { section: "Commitments", text: "Send the draft by Friday", source: "the user" }),
  ]);
  const memory = files.text("memory/MEMORY.md") ?? "";
  assert.match(memory, /iced Americano/);
  assert.match(memory, /draft by Friday/);
  assert.match(files.text("memory/USER.md") ?? "", /Xiaoming/);
  const journal = files.text("memory/journal/2026-10-21.md") ?? "";
  for (const { id } of ids) assert.match(journal, new RegExp(id));
});

test("memoryBrief puts Preferences and Commitments first so a long Facts section never crowds them out", async () => {
  const files = memoryWorkspace();
  for (let i = 0; i < 60; i++) await remember(files, io, { section: "Facts", text: `Fact ${i} ${"x".repeat(120)}`, source: "the user" });
  await remember(files, io, { section: "Preferences", text: "Keep replies short and direct", source: "the user" });
  await remember(files, io, { section: "Commitments", text: "Send the camera roll by Sunday", source: "the user" });
  assert.ok((files.text("memory/MEMORY.md") ?? "").length > 7_000, "Facts alone is past the brief limit");
  const brief = await memoryBrief(files);
  const at = (part: string) => brief.indexOf(part);
  assert.ok(at("## Preferences") > 0 && at("Keep replies short and direct") > at("## Preferences"));
  assert.ok(at("## Commitments") > at("## Preferences") && at("Send the camera roll by Sunday") > at("## Commitments"));
  assert.ok(at("## Facts") > at("## Commitments"), "Preferences and Commitments come before Facts");
  // Facts keeps its newest lines, whole, and says how many older ones are left out, with a tool the turn has
  assert.match(brief, /\(\d+ older lines not shown; memory_search finds them\)/);
  assert.match(brief, /Fact 59 x+ \(m-[^)]+\)/, "the newest fact is there");
  assert.doesNotMatch(brief, /Fact 0 x/, "the oldest is what goes");
  assert.doesNotMatch(brief, /memory_get/, "no tool the turn does not declare");
  const facts = brief.slice(brief.indexOf("## Facts"));
  for (const line of facts.split("\n").slice(2)) if (line.trim()) assert.match(line, /^- Fact \d+ x+ \(m-[^)]+\)$|^## /, `a whole line: ${line.slice(0, 40)}`);
  assert.match(brief, /What is true now about the user\. Each line ends with its id/, "MEMORY.md's own words on its ids stay");
});
