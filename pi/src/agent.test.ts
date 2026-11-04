import assert from "node:assert/strict";
import { test } from "node:test";
import type { Turn } from "@amuse/core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { PiConfig } from "./agent.ts";
import type { Apps } from "./tools.ts";
import { parseModel, pick, redact } from "./index.ts";

test("model specs split at the first slash; ids may contain more", () => {
  assert.deepEqual(parseModel("openrouter/z-ai/glm-5.3-flash"), { provider: "openrouter", id: "z-ai/glm-5.3-flash" });
  assert.equal(parseModel("glm"), undefined);
  assert.equal(parseModel("/x"), undefined);
  assert.equal(parseModel("p/"), undefined);
});

test("errors lose credentials and credential paths", () => {
  const text = redact("401 from https://x with Bearer abcdefghijklmnop, key in /home/u/auth.json: sk-or-v1-0123456789abcdefABCDEF", ["/home/u/auth.json"]);
  assert.doesNotMatch(text, /abcdefghijklmnop|auth\.json|sk-or-v1/);
  assert.match(text, /<redacted>/);
  assert.equal(redact(""), "The model run failed");
});

test("the read-only credential store parses Pi auth files and refuses writes", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { readOnlyCredentials } = await import("./credentials.ts");
  const dir = mkdtempSync(join(tmpdir(), "amuse-auth-"));
  const good = join(dir, "auth.json");
  writeFileSync(good, JSON.stringify({ openrouter: { type: "api_key", key: "sk-test" } }));
  const store = readOnlyCredentials(good);
  assert.deepEqual(await store.read("openrouter"), { type: "api_key", key: "sk-test" });
  assert.deepEqual(await store.list(), [{ providerId: "openrouter", type: "api_key" }]);
  await assert.rejects(store.delete("openrouter"), /read-only/);
  const bad = join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ x: { type: "password", value: "secret-value" } }));
  await assert.rejects(readOnlyCredentials(bad).read("x"), (e: Error) => !e.message.includes("secret-value"));
});

test("an app with several accounts asks which; one is used as is; an account is found by its email", () => {
  const one = [{ id: "ca_1", label: "me@a.com" }];
  const two = [...one, { id: "ca_2", label: "work@b.com" }];
  assert.deepEqual(pick("gmail", one, undefined), { ok: true, account: one[0] });
  const unsure = pick("gmail", two, undefined);
  assert.ok(!unsure.ok && /several accounts: me@a.com, work@b.com/.test(unsure.text));
  assert.deepEqual(pick("gmail", two, "WORK@b.com"), { ok: true, account: two[1] });
  assert.ok(!pick("gmail", two, "x@c.com").ok);
  assert.ok(!pick("gmail", [], undefined).ok);
});

test("the user's language is told by the script they write in, links aside", async () => {
  const { scriptOf } = await import("./agent.ts");
  assert.equal(scriptOf("用浏览器打开 https://example.com/download 下载第一个文件"), "Chinese");
  assert.equal(scriptOf("ダウンロードして"), "Japanese");
  assert.equal(scriptOf("다운로드해 줘"), "Korean");
  assert.equal(scriptOf("open https://例え.jp/ please"), null);
  assert.equal(scriptOf("download the first file"), null);
});

test("new and changed skills of the user's are told once; the first look and the built-in ones are not", async () => {
  const { skillsSince } = await import("./agent.ts");
  const skill = (name: string, description: string, from = `skills/${name}`) => ({ name, description, body: "Do it.", from });
  const first = skillsSince(null, [skill("trips", "Planning trips"), skill("memory", "Built in", "built in")]);
  assert.equal(first.news, "");
  const later = skillsSince(first.seen, [skill("trips", "Planning trips, the way I like"), skill("pdf", "PDF tools"), skill("memory", "Changed", "built in")]);
  assert.match(later.news, /^- trips \(changed\): Planning trips, the way I like$/m);
  assert.match(later.news, /^- pdf \(new\): PDF tools$/m);
  assert.doesNotMatch(later.news, /memory/);
  assert.equal(skillsSince(later.seen, [skill("trips", "Planning trips, the way I like"), skill("pdf", "PDF tools")]).news, "", "told once");
});

const noon = "2026-10-21T12:00:00Z";
/** The part of a chat a brief is built from; `live`: what is running now, as the host gives it (live.ts). */
const room = (context: string, now = noon, main = true, live = "") => ({
  chat: "c-1",
  chats: () => [{ id: "c-1", title: "Trip", main, updated: noon }],
  context: () => context,
  time: () => ({ now, timezone: "UTC" }),
  running: () => live,
});

test("a turn's message tells what holds still first and what is new last: the conversation, then where, memory, language, now and the newest user message", async () => {
  const { brief } = await import("./agent.ts");
  const conversation = Array.from({ length: 80 }, (_, i) => `[2026-10-21 08:00] User: line ${i} ${"x".repeat(200)}`).join("\n");
  const told = brief(room(conversation, noon, false), { kind: "message", text: "hi", attachments: [], quote: null }, "Your memory of the user: likes tea", [], "Chinese", "");
  const at = (part: string) => told.text.indexOf(part);
  const volatile = ["You are in a side chat", "Your memory of the user: likes tea", "The user writes in Chinese: reply in Chinese.", "Now: ", "Reply to the user's newest message:\nhi"];
  assert.ok(at(conversation) > 0 && at("The conversation so far") === 0, "the heading, then the conversation");
  for (const part of volatile) assert.ok(at(part) > at(conversation) + conversation.length, `${part} comes after the conversation`);
  assert.deepEqual(volatile.map(at), volatile.map(at).toSorted((a, b) => a - b), "and in that order, the newest user message last");
  assert.ok(told.text.endsWith("Reply to the user's newest message:\nhi"));
  assert.doesNotMatch(told.text, /\brecall\b/);
  // what is kept from turn to turn is the heading and the conversation, whole parts of it, and none of the volatile
  assert.ok(told.stable.length > 0 && told.text.startsWith(told.stable.join("")));
  for (const part of volatile) assert.ok(!told.stable.join("").includes(part));
});

test("the message of the next turn begins with the message of this one up to where the chat grew; the volatile parts alone never move it", async () => {
  const { brief } = await import("./agent.ts");
  const lines = Array.from({ length: 80 }, (_, i) => `[2026-10-21 08:00] User: line ${i} ${"x".repeat(200)}`);
  const message: Turn = { kind: "message", text: "hi", attachments: [], quote: null };
  const first = brief(room(lines.slice(0, 60).join("\n")), message, "memory one", [], null, "");
  const second = brief(room(lines.join("\n"), "2026-10-21T13:00:00Z"), message, "memory two, rewritten", [], "Japanese", "");
  assert.ok(first.stable.length > 0);
  assert.deepEqual(second.stable.slice(0, first.stable.length), first.stable, "the parts that were closed are the same, the next turn too");
  assert.ok(second.text.startsWith(first.stable.join("")), "what the provider cached is what this one begins with");
});

test("a note turn is briefed the same way; when the user wrote too, their newest message comes after the note, last", async () => {
  const { brief } = await import("./agent.ts");
  const quiet = brief(room("[2026-10-21 08:00] User: hi"), { kind: "note", text: "[task t-1 done] ok" }, "", [], null, "");
  assert.match(quiet.text, /\n---\nYou are in the main chat\.\n\nNow: .*\.\nA note from your background work.*call no_reply.*\n\[task t-1 done\] ok$/s);
  // the note rules make the call mandatory and say what writing the name would do (issue #82: it reached the user)
  assert.match(quiet.text, /you must call no_reply: that call is the only way this turn ends without a message/);
  assert.match(quiet.text, /writing its name, or anything standing in for it, is a message to them and never silence/);
  const wrote = brief(room("[2026-10-21 08:00] User: hi"), { kind: "note", text: "[task t-1 done] ok" }, "", [{ kind: "message", text: "is it done?", attachments: [], quote: null, suggested: true }], null, "");
  assert.match(wrote.text, /A note from your background work \(not from the user\), and the user has also written since\..*\n\[task t-1 done\] ok\n\nThe user's newest message:\n\(they tapped one of your suggested replies\)\nis it done\?$/s);
  assert.doesNotMatch(wrote.text, /last lines above/);
});

test("the user's messages a turn answers are given together, last, with what they reply to and their files", async () => {
  const { brief } = await import("./agent.ts");
  const quote = { id: "r1", kind: "reply" as const, text: "Shall I book it?", state: null };
  const file = { id: "f-1", name: "a.png", type: "image/png", size: 1024, path: "user/a.png" };
  const told = brief(
    room("[2026-10-21 08:00] User: hi"),
    { kind: "message", text: "second", attachments: [], quote: null },
    "",
    [
      { kind: "message", text: "first", attachments: [file], quote: null },
      { kind: "message", text: "second", attachments: [], quote },
    ],
    null,
    "",
  );
  assert.match(told.text, /Reply to the user's newest message:\n\(replying to your message "Shall I book it\?"\)\nfirst\nsecond\nAttached: a\.png \(image\/png, 1 KB\) at user\/a\.png$/);
});

test("a helper is briefed with the conversation first and the work last", async () => {
  const { briefed } = await import("./worker.ts");
  const text = briefed({ context: () => "[2026-10-21 08:00] User: hi" }, "Wednesday noon", 'Task "x". Instructions:\nDo it.');
  assert.ok(text.indexOf("User: hi") < text.indexOf("Now: Wednesday noon") && text.indexOf("Now: ") < text.indexOf("Instructions:"));
});

test("what is running now is in every turn, after the part the provider caches, and nothing is said when nothing runs", async () => {
  const { brief } = await import("./agent.ts");
  const conversation = Array.from({ length: 80 }, (_, i) => `[2026-10-21 08:00] User: line ${i} ${"x".repeat(200)}`).join("\n");
  const live = 'What is running now:\n- browser task "SHAPE training" (b-1): running, now "进入下一节（2.02）" (2 minutes ago)';
  const message: Turn = { kind: "message", text: "在做了吗", attachments: [], quote: null };
  const told = brief(room(conversation, noon, true, live), message, "Your memory of the user: likes tea", [], null, '[browser task "SHAPE training" (b-1): the user handed it back; it is carrying on]');
  const stable = told.stable.join("");
  assert.ok(stable.length > 0 && told.text.startsWith(stable), "the heading and the conversation hold still");
  assert.ok(told.text.indexOf("What is running now") > stable.length, "the live state sits after the cached prefix, so it never breaks the cache");
  assert.doesNotMatch(stable, /What is running now|the user handed it back/, "and is none of what is kept from turn to turn");
  assert.match(
    told.text,
    /\n---\nYou are in the main chat\.\n\nWhat is running now:\n- browser task "SHAPE training" \(b-1\): running, now "进入下一节（2\.02）" \(2 minutes ago\)\n\nSince your last turn:\n\[browser task "SHAPE training" \(b-1\): the user handed it back; it is carrying on\]\n\nYour memory of the user: likes tea\n\nNow: .*\nReply to the user's newest message:\n在做了吗$/s,
  );
  // a turn with nothing running and nothing kept reads as it did before
  const quiet = brief(room(conversation), message, "", [], null, "");
  assert.doesNotMatch(quiet.text, /What is running now|Since your last turn/);
  assert.match(quiet.text, /\n---\nYou are in the main chat\.\n\nNow: /);
});

test("the chat's tools come in the same order with the same schemas however often, and whatever the skills' order", async () => {
  const { agentTools } = await import("./agent.ts");
  const { memoryRules, noWorkspace } = await import("@amuse/core");
  const { allSkills } = await import("./skills.ts");
  const apps: Apps = { accounts: async () => [], tools: async () => [], permission: async () => "ask", kind: async () => "read", remember: async () => {}, call: async () => ({ ok: true, data: null }) };
  const skill = (name: string) => ({ name, description: `About ${name}`, body: "Do it.", from: "built in" });
  const build = (skills: ReturnType<typeof skill>[]) => {
    const io = () => {
      throw new Error("not used to build tools");
    };
    const cfg: PiConfig = { model: () => null, auth: { kind: "environment" }, system: "s", rules: memoryRules(), files: noWorkspace, apps, skills, about: async () => "", search: async () => [] };
    return agentTools(cfg, io, () => false, () => {}, () => {}).map((t) => JSON.stringify([t.name, t.description, t.parameters]));
  };
  const one = build([skill("a"), skill("b")]);
  assert.ok(one.length > 20);
  assert.deepEqual(build([skill("b"), skill("a")]), one);
  assert.deepEqual(build([skill("a"), skill("b")]), one);
  assert.equal(new Set(one.map((t) => JSON.parse(t)[0])).size, one.length, "no tool twice");
  assert.ok(!one.some((t) => JSON.parse(t)[0] === "recall"), "no recall when workspace memory is configured");
  const names = (await allSkills([skill("b"), skill("c"), skill("a")], undefined)).map((s) => s.name);
  assert.deepEqual(names, ["a", "b", "c"], "the catalog is by name");
});

test("each turn of a chat opens a session of the chat's own name, and its system prompt is byte-identical across turns without <cwd>", async () => {
  const { fauxAssistantMessage, getCurrentSystemPrompt } = await import("@earendil-works/pi-ai");
  const { chat } = await import("./scripted-chat.ts");
  const systems: string[] = [];
  const users: string[] = [];
  const ids: string[] = [];
  const seen = (context: Parameters<typeof getCurrentSystemPrompt>[0] extends infer M ? { messages: M } : never) => {
    const text = (content: unknown) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("") : "");
    systems.push(getCurrentSystemPrompt(context.messages) ?? "");
    const user = context.messages.find((m) => m.role === "user");
    users.push(user && "content" in user ? text(user.content) : "");
    return fauxAssistantMessage("ok");
  };
  const { agent, io, until } = await chat([seen, seen], { opened: (session) => ids.push(session.sessionId) });
  const message: Turn = { kind: "message", text: "hello", attachments: [], quote: null };
  agent.prompt(message, io);
  await until(1);
  agent.prompt(message, { ...io, lastWords: () => "你好，帮我看看" });
  await until(2);
  assert.deepEqual(ids, ["amuse-main", "amuse-main"]);
  assert.ok((systems[0]?.length ?? 0) > 0, "system prompt is non-empty");
  assert.equal(systems[0], systems[1], "system prompt is byte-identical across turns");
  assert.doesNotMatch(systems[0] ?? "", /<cwd>/, "no random per-turn <cwd> tag in system prompt");
  assert.doesNotMatch(systems[1] ?? "", /writes in/);
  assert.doesNotMatch(users[0] ?? "", /writes in/);
  assert.match(users[1] ?? "", /\nThe user writes in Chinese: reply in Chinese\.\n\nNow: .*\nReply to the user's newest message:\nhello$/s);
});

test("a chat turn declares only the core tools initially and unlocks a skill's tools when use_skill is called", async () => {
  const { noWorkspace } = await import("@amuse/core");
  const { builtInSkills } = await import("./skills.ts");
  const { fauxAssistantMessage, fauxToolCall, getCurrentTools } = await import("@earendil-works/pi-ai");
  const { chat } = await import("./scripted-chat.ts");
  const declaredPerStep: string[][] = [];
  const { agent, io, until } = await chat(
    [
      (context) => {
        declaredPerStep.push(getCurrentTools(context.messages).map((t) => t.name));
        return fauxAssistantMessage([fauxToolCall("use_skill", { name: "schedules" })], { stopReason: "toolUse" });
      },
      (context) => {
        declaredPerStep.push(getCurrentTools(context.messages).map((t) => t.name));
        return fauxAssistantMessage("done");
      },
    ],
    { files: noWorkspace, skills: builtInSkills(), codemode: true },
  );
  agent.prompt({ kind: "message", text: "set a reminder", attachments: [], quote: null }, io);
  await until(1);
  assert.equal(declaredPerStep.length, 2);
  const initial = declaredPerStep[0] ?? [];
  const afterSkill = declaredPerStep[1] ?? [];
  assert.ok(initial.includes("use_skill") && initial.includes("memory_search") && initial.includes("remember"));
  assert.ok(!initial.includes("schedule") && !initial.includes("list_schedules") && !initial.includes("write_file"), "skill-gated tools are hidden before use_skill");
  assert.ok(afterSkill.includes("schedule") && afterSkill.includes("list_schedules") && afterSkill.includes("cancel_schedule"), "schedules tools are declared after use_skill('schedules')");
  assert.deepEqual(afterSkill.slice(0, initial.length), initial, "the tools the turn began with keep their place");
  assert.deepEqual(afterSkill.slice(initial.length), ["schedule", "list_schedules", "cancel_schedule"], "and the unlocked ones come after them");
});

test("the session marks the request's cache where the turn's message holds still, reading it as each request is made", async () => {
  const { fauxAssistantMessage } = await import("@earendil-works/pi-ai");
  const { chat } = await import("./scripted-chat.ts");
  const hooks: NonNullable<AgentSession["agent"]["onPayload"]>[] = [];
  const { agent, io, faux, conversation, until } = await chat([fauxAssistantMessage("ok")], {
    opened: (session) => {
      const hook = session.agent.onPayload;
      if (hook) hooks.push(hook);
    },
  });
  for (let i = 0; i < 40; i++) conversation.push(`[2026-10-21 08:00] User: line ${i} ${"x".repeat(200)}`);
  agent.prompt({ kind: "message", text: "hello", attachments: [], quote: null }, io);
  await until(1);
  assert.equal(hooks.length, 1, "set where the session opens");
  const mark = { type: "ephemeral" };
  const request = (text: string) => ({ system: [{ type: "text", text: "rules", cache_control: mark }], messages: [{ role: "user", content: [{ type: "text", text, cache_control: mark }] }] });
  const text = `The conversation so far, oldest first (times are the user's, UTC):\n\n${conversation.join("\n")}\n\n---\nYou are in the main chat.\n\nNow: x.\nReply.`;
  const marked = await hooks[0]?.(request(text), faux.getModel());
  assert.ok(marked !== null && typeof marked === "object" && "messages" in marked && Array.isArray(marked.messages));
  const content = marked.messages[0].content;
  assert.ok(content.length >= 2 && content[0].cache_control !== undefined, "a mark inside the message, apart from its end");
  assert.deepEqual(content.at(-1).cache_control, mark, "and the one at its end stays");
  assert.equal(content.map((b: { text: string }) => b.text).join(""), text);
});

test("the chat turn asks for the conversation within the window it computed for this turn's model", async () => {
  const { brief } = await import("./agent.ts");
  const asked: (unknown[] | undefined)[] = [];
  const told = brief({ ...room(""), context: (limits?: unknown) => (asked.push(limits as unknown[] | undefined), "the chat window") }, { kind: "message", text: "hi", attachments: [], quote: null }, "", [], null, "", { full: 500_000, brief: 166_667 });
  assert.deepEqual(asked, [{ full: 500_000, brief: 166_667 }]);
  assert.match(told.text, /the chat window/);
});

test("the tools a chat turn starts with: the core ones and the controls of running work, with every other tool behind a skill", async () => {
  const { agentTools } = await import("./agent.ts");
  const { memoryRules, noWorkspace } = await import("@amuse/core");
  const { builtInSkills, GATED_TOOLS } = await import("./skills.ts");
  const stub = new Proxy({}, { get: () => async () => ({}) }) as never;
  const cfg: PiConfig = { model: () => null, auth: { kind: "environment" }, system: "s", rules: memoryRules(), files: noWorkspace, apps: stub, skills: builtInSkills(), about: async () => "", search: async () => [], sandbox: stub, browsers: stub, secrets: stub };
  const io = () => {
    throw new Error("not used to build tools");
  };
  const names = agentTools(cfg, io, () => false, () => {}, () => {}).map((t) => t.name);
  assert.deepEqual(
    names.filter((n) => !GATED_TOOLS.has(n)),
    ["current_time", "browse", "read_browser", "memory_search", "remember", "use_skill", "start_task", "message_run", "answer_question", "stop_run", "web_search", "web_read", "job_output", "stop_job", "say", "no_reply", "suggest_replies"],
  );
});

test("with codemode, as in production, the system prompt and the tools a turn starts with are the same bytes whether or not something runs", async () => {
  const { fauxAssistantMessage, getCurrentSystemPrompt, getCurrentTools } = await import("@earendil-works/pi-ai");
  const { noWorkspace } = await import("@amuse/core");
  const { builtInSkills } = await import("./skills.ts");
  const { chat } = await import("./scripted-chat.ts");
  const seen: { system: string; tools: string }[] = [];
  const record = (context: { messages: Parameters<typeof getCurrentTools>[0] }) => {
    seen.push({ system: getCurrentSystemPrompt(context.messages), tools: JSON.stringify(getCurrentTools(context.messages)) });
    return fauxAssistantMessage("ok");
  };
  const message: Turn = { kind: "message", text: "hello", attachments: [], quote: null };
  for (const live of ["", 'What is running now:\n- browser task "Book" (b-1): running, now "Paying" (1 minute ago)']) {
    const { agent, io, until } = await chat([record, record], { codemode: true, files: noWorkspace, skills: builtInSkills(), live });
    agent.prompt(message, io);
    await until(1);
    agent.prompt(message, io);
    await until(2);
  }
  assert.equal(seen.length, 4);
  assert.ok(seen[0]!.system.length > 0 && !/<cwd>/.test(seen[0]!.system));
  assert.ok(seen[0]!.tools.includes('"name":"codemode"') && seen[0]!.tools.includes('"name":"stop_run"'));
  assert.doesNotMatch(seen[0]!.tools, /Codemode: tools\./, "no per-tool codemode notes");
  for (const s of seen) assert.deepEqual(s, seen[0], "idle or running, first turn or next");
});
