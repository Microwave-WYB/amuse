import assert from "node:assert/strict";
import { test } from "node:test";
import { type Account, type Envelope, type FieldValue, type Schedule, type Session, type State, apply, prepend } from "@amuse/protocol";
import { type AgentIO, type Keys, type Ports, type Timers, type Turn, createHost, memoryChats, memoryRules, noKeys, noLogins, noSandbox, noSecrets, noWorkspace } from "./index.ts";

/** Ports that do nothing but hand over the AgentIO, so tests can act like an agent. */
function capture() {
  let io: AgentIO | undefined;
  const runs: Schedule[] = [];
  const ports: Ports = {
    prompt: (_, agent) => void (io = agent),
    title: async (text) => text.split(" ").slice(0, 3).join(" "),
    schedule: (schedule, agent) => {
      io = agent;
      runs.push(schedule);
    },
    interrupt: () => {},
    browse: () => {},
    job: () => {},
    task: () => {},
    browser: () => {},
    approval: () => {},
    stopTask: () => {},
    fit: () => {},
    connect: async () => "https://connect.example/",
    apps: {
      search: async () => ({ apps: [], cursor: null }),
      accounts: async () => [],
      connect: async () => "https://connect.example/",
      access: async () => ({ kind: "managed" }),
      cannotConnect: async () => null,
      connectKey: async () => {},
      disconnect: async () => {},
      permissions: async () => [],
      permit: async () => {},
    },
    rules: memoryRules(),
    // one file was uploaded: the cat photo
    keys: noKeys,
    logins: noLogins,
    sandbox: noSandbox,
    secrets: noSecrets,
    files: { ...noWorkspace, holds: async (a) => a.id === "f-cat" && a.name === "cat.jpg" && a.size === 2048 },
  };
  return { ports, io: () => io, runs };
}

/** A clock and timers the test moves by hand. */
function manualTime(start: string) {
  let now = Date.parse(start);
  const pending = new Map<number, { at: number; fn: () => void }>();
  let next = 0;
  const timers: Timers<number> = {
    set: (ms, fn) => {
      pending.set(++next, { at: now + ms, fn });
      return next;
    },
    clear: (handle) => void pending.delete(handle),
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...pending.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      pending.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = until;
  };
  return { clock: { now: () => new Date(now).toISOString() }, timers, advance, waiting: () => pending.size };
}

test("a decision already made is answered at once; one still open waits for the user", async () => {
  const { ports, io } = capture();
  const host = createHost(ports);
  await host.call("chat.send", { chat: "main", text: "go", timezone: "UTC", attachments: [] });
  const agent = io();
  assert.ok(agent);
  const asked = agent.act({ kind: "ask", action: "send", target: "gmail", detail: "{}", remember: true });
  assert.ok(asked.ok);
  const early = agent.decision(asked.id);
  await host.call("approval.resolve", { id: asked.id, resolution: "allow_once" });
  assert.deepEqual(await early, { verdict: "approved", remember: false });
  assert.deepEqual(await agent.decision(asked.id), { verdict: "approved", remember: false }); // asked again after the fact
});

test("an agent cannot move a run the user stopped", async () => {
  const { ports, io } = capture();
  const host = createHost(ports);
  await host.call("chat.send", { chat: "main", text: "go", timezone: "UTC", attachments: [] });
  const agent = io();
  assert.ok(agent);
  const started = agent.act({ kind: "browse", title: "t", url: "https://x.example/", instructions: "t", files: [] });
  assert.ok(started.ok);
  await host.call("browser.control", { id: started.id, action: "stop" });
  assert.deepEqual(agent.act({ kind: "browserEnded", id: started.id, status: "completed", result: "done" }), {
    ok: false,
    rejection: { kind: "invalid", action: "browserEnded", from: "stopped" },
  });
});

test("a client holding only the recent end sees what the whole feed shows there, and pages back to all of it", async () => {
  const { ports, io } = capture();
  const host = createHost(ports, { snapshot: 3 });
  for (const text of ["a", "b", "c", "d", "e"]) await host.call("chat.send", { chat: "main", text, timezone: "UTC", attachments: [] });
  const agent = io();
  assert.ok(agent);
  const run = agent.act({ kind: "browse", title: "t", url: "https://x.example/", instructions: "t", files: [] });
  assert.ok(run.ok);
  for (const text of ["f", "g", "h", "i"]) await host.call("chat.send", { chat: "main", text, timezone: "UTC", attachments: [] });

  const synced = await host.call("session.sync", { chat: "main", since: null });
  assert.ok(synced.kind === "snapshot");
  let client = synced.state;
  assert.equal(client.earlier, 5); // reaches back to the run still in play
  host.subscribe((u) => {
    if (u.kind === "event") client = apply(client, u.envelope);
  });

  agent.act({ kind: "browserEnded", id: run.id, status: "completed", result: "done" });
  await host.call("chat.send", { chat: "main", text: "j", timezone: "UTC", attachments: [] });
  while (client.earlier > 0) {
    const page = await host.call("session.history", { chat: "main", before: client.earlier, limit: 2 });
    const next = prepend(client, page);
    assert.ok(next);
    client = next;
  }
  const whole = await wholeFeed(host);
  assert.deepEqual(client, whole);
});

/** The whole feed, as a client with an unlimited window would hold it. */
async function wholeFeed(host: Session): Promise<State> {
  const page = await host.call("session.history", { chat: "main", before: Number.MAX_SAFE_INTEGER, limit: 200 });
  const synced = await host.call("session.sync", { chat: "main", since: null });
  assert.ok(synced.kind === "snapshot");
  return { ...synced.state, earlier: 0, entities: page.entities };
}

test("a schedule runs in the background when its time comes, and again the next day", async () => {
  const { ports, io, runs } = capture();
  const time = manualTime("2026-10-20T08:00:00Z");
  const host = createHost(ports, { clock: time.clock, timers: time.timers });
  await host.call("chat.send", { chat: "main", text: "brief me at 8", timezone: "Asia/Shanghai", attachments: [] });
  const agent = io();
  assert.ok(agent);
  assert.deepEqual(agent.time(), { now: "2026-10-20T08:00:00.000Z", timezone: "Asia/Shanghai" });
  const made = agent.act({ kind: "schedule", title: "Briefing", instructions: "Sum up the day", when: { kind: "repeat", cron: "0 8 * * *", timezone: "Asia/Shanghai" } });
  assert.ok(made.ok);
  time.advance(15 * 60 * 60_000); // to 23:00 UTC, 07:00 in Shanghai
  assert.equal(runs.length, 0);
  time.advance(60 * 60_000);
  assert.deepEqual(runs.map((r) => r.next), ["2026-10-22T00:00:00.000Z"]);
  agent.act({ kind: "scheduleRan", id: made.id, outcome: "quiet", summary: "Nothing new" });
  time.advance(24 * 60 * 60_000);
  assert.equal(runs.length, 2);
  const { schedules } = await host.call("schedules.list", {});
  assert.equal(schedules[0]?.last?.outcome, "quiet");
});

test("an approval nobody answers times out, as a no to whoever waits on it", async () => {
  const { ports, io } = capture();
  const time = manualTime("2026-10-20T08:00:00Z");
  const host = createHost(ports, { clock: time.clock, timers: time.timers });
  await host.call("chat.send", { chat: "main", text: "send it", timezone: "UTC", attachments: [] });
  const agent = io();
  assert.ok(agent);
  const asked = agent.act({ kind: "ask", action: "send", target: "gmail", detail: "{}", remember: true });
  assert.ok(asked.ok);
  const answer = agent.decision(asked.id);
  time.advance(30 * 60_000);
  assert.deepEqual(await answer, { verdict: "timed_out", remember: false });
  await assert.rejects(host.call("approval.resolve", { id: asked.id, resolution: "allow_once" }), /cannot resolve from timed_out/);
  assert.equal(time.waiting(), 0, "nothing left to wait for");
});

/** A host with one browser run in flight, and the agent's IO. */
async function withRun() {
  const { ports, io, runs } = capture();
  const time = manualTime("2026-10-20T08:00:00Z");
  const host = createHost(ports, { clock: time.clock, timers: time.timers });
  await host.call("chat.send", { chat: "main", text: "check the tides", timezone: "UTC", attachments: [] });
  const agent = io();
  assert.ok(agent);
  const run = agent.act({ kind: "browse", title: "Tides", url: "https://tides.example/", instructions: "Read today's tides", files: [] });
  assert.ok(run.ok);
  const entity = async (id: string) => (await host.call("session.history", { chat: "main", before: 1000, limit: 200 })).entities.find((e) => e.id === id);
  return { host, agent, run: run.id, time, runs, entity };
}

test("Amuse tells a run in flight something more: it is recorded, and the run hears it; a run that ended hears nothing", async () => {
  const { host, agent, run, entity } = await withRun();
  const heard: string[] = [];
  const stop = agent.listen(run, (m) => heard.push(m.kind === "instruction" ? m.text : "stop"));
  const told = agent.act({ kind: "instruct", run, text: "Also check tomorrow" });
  assert.ok(told.ok);
  assert.deepEqual(heard, ["Also check tomorrow"]);
  assert.equal((await entity(told.id))?.kind, "instruction");
  stop();
  await host.call("browser.control", { id: run, action: "stop" });
  assert.deepEqual(agent.act({ kind: "instruct", run, text: "and the day after" }), { ok: false, rejection: { kind: "notRunning", id: run } });
});

test("a run's question waits for Amuse's answer; the run waits for the user meanwhile; one answer only", async () => {
  const { agent, run, entity } = await withRun();
  const asked = agent.act({ kind: "question", run, text: "Which beach?" });
  assert.ok(asked.ok);
  const browser = await entity(run);
  assert.equal(browser?.kind === "browser" && browser.status, "waiting");
  const answer = agent.answer(asked.id);
  assert.ok(agent.act({ kind: "answer", id: asked.id, text: "Ocean Beach" }).ok);
  assert.deepEqual(await answer, { kind: "answered", text: "Ocean Beach" });
  assert.deepEqual(await agent.answer(asked.id), { kind: "answered", text: "Ocean Beach" }, "asked again after the fact");
  assert.deepEqual(agent.act({ kind: "answer", id: asked.id, text: "Baker Beach" }), { ok: false, rejection: { kind: "invalid", action: "answer", from: "answered" } });
});

test("a question nobody answers times out; one whose run ends is closed", async () => {
  const { agent, run, time } = await withRun();
  const late = agent.act({ kind: "question", run, text: "Which beach?" });
  assert.ok(late.ok);
  const waiting = agent.answer(late.id);
  time.advance(30 * 60_000);
  assert.deepEqual(await waiting, { kind: "timed_out" });
  const left = agent.act({ kind: "question", run, text: "Morning or evening?" });
  assert.ok(left.ok);
  const unanswered = agent.answer(left.id);
  agent.act({ kind: "browserEnded", id: run, status: "completed", result: "Low tide at 9" });
  assert.deepEqual(await unanswered, { kind: "closed" });
});

test("Amuse stops a run in flight, but not one the user holds; a schedule's run hears the stop", async () => {
  const { host, agent, run, entity, time, runs } = await withRun();
  await host.call("browser.control", { id: run, action: "take" });
  assert.deepEqual(agent.act({ kind: "stopRun", run }), { ok: false, rejection: { kind: "invalid", action: "stopRun", from: "paused" } });
  await host.call("browser.control", { id: run, action: "handBack" });
  assert.ok(agent.act({ kind: "stopRun", run }).ok);
  const browser = await entity(run);
  assert.equal(browser?.kind === "browser" && browser.status, "stopped");

  const made = agent.act({ kind: "schedule", title: "Hourly", instructions: "Look at the mail", when: { kind: "repeat", cron: "0 * * * *", timezone: "UTC" } });
  assert.ok(made.ok);
  time.advance(60 * 60_000);
  assert.equal(runs.length, 1);
  const heard: string[] = [];
  agent.listen(made.id, (m) => heard.push(m.kind));
  assert.ok(agent.act({ kind: "stopRun", run: made.id }).ok);
  assert.deepEqual(heard, ["stop"]);
});

test("side chats: each its own feed and agent, named after its first message, listed by use, renamed, deleted", async () => {
  const { ports, io } = capture();
  const time = manualTime("2026-10-20T08:00:00Z");
  const store = memoryChats();
  const host = createHost(ports, { clock: time.clock, timers: time.timers, store });
  const pushed: string[][] = [];
  host.subscribe((u) => void (u.kind === "chats" && pushed.push(u.chats.map((c) => c.title))));
  await host.call("chat.send", { chat: "main", text: "hello main", timezone: "UTC", attachments: [] });
  const side = await host.call("chats.create", {});
  time.advance(60_000);
  await host.call("chat.send", { chat: side.id, text: "plan the trip please", timezone: "UTC", attachments: [] });
  await new Promise((r) => setImmediate(r)); // the title arrives
  const agent = io();
  assert.equal(agent?.chat, side.id, "the side chat's agent answers it");

  const { chats } = await host.call("chats.list", {});
  assert.deepEqual(chats.map((c) => [c.id === "main" ? "main" : "side", c.title]), [["main", ""], ["side", "plan the trip"]]);
  assert.ok(pushed.some((titles) => titles.includes("plan the trip")));
  const feeds = await Promise.all(["main", side.id].map((chat) => host.call("session.history", { chat, before: 100, limit: 100 })));
  assert.deepEqual(feeds.map((f) => f.entities.map((e) => (e.kind === "prompt" ? e.text : e.kind))), [["hello main"], ["plan the trip please"]]);

  // the side chat's agent sees only its chat, and can read and search the others
  assert.ok(agent);
  assert.doesNotMatch(agent.context(), /hello main/);
  assert.match(agent.readChat("main") ?? "", /hello main/);
  assert.match(agent.recall("hello", true), /In "Main chat" \(main\):[\s\S]*hello main/);
  assert.deepEqual(agent.chats().map((c) => c.title), ["Main chat", "plan the trip"]);

  // a schedule set up in a side chat lives in the main chat, where its runs report
  const made = agent.act({ kind: "schedule", title: "Briefing", instructions: "x", when: { kind: "repeat", cron: "0 8 * * *", timezone: "UTC" } });
  assert.ok(made.ok);
  const mainFeed = await host.call("session.history", { chat: "main", before: 100, limit: 100 });
  assert.ok(mainFeed.entities.some((e) => e.id === made.id));

  await host.call("chats.rename", { id: side.id, title: "Trip" });
  assert.equal((await host.call("chats.list", {})).chats[1]?.title, "Trip");
  await assert.rejects(host.call("chats.rename", { id: "main", title: "x" }), /main chat cannot be renamed/);
  await host.call("chats.delete", { id: side.id });
  assert.equal((await host.call("chats.list", {})).chats.length, 1);
  await assert.rejects(host.call("session.sync", { chat: side.id, since: null }), /no chat/);
});

test("chats and their feeds survive a restart", async () => {
  const store = memoryChats();
  const first = createHost(capture().ports, { store, timers: manualTime("2026-10-20T08:00:00Z").timers });
  const side = await first.call("chats.create", {});
  await first.call("chat.send", { chat: side.id, text: "remember this", timezone: "UTC", attachments: [] });
  const second = createHost(capture().ports, { store, timers: manualTime("2026-10-20T08:00:00Z").timers });
  const { chats } = await second.call("chats.list", {});
  assert.deepEqual(chats.map((c) => c.id), ["main", side.id]);
  const synced = await second.call("session.sync", { chat: side.id, since: null });
  assert.ok(synced.kind === "snapshot" && synced.state.entities.some((e) => e.kind === "prompt" && e.text === "remember this"));
});

test("a file is sent with a message only as it was uploaded; the agent gets it with the message", async () => {
  const turns: Turn[] = [];
  const { ports } = capture();
  const host = createHost({ ...ports, prompt: (turn) => void turns.push(turn) });
  const cat = { id: "f-cat", name: "cat.jpg", type: "image/jpeg", size: 2048, path: "user/media_library/cat.jpg" };
  await host.call("chat.send", { chat: "main", text: "", timezone: "UTC", attachments: [cat] });
  assert.deepEqual(turns, [{ kind: "message", text: "", attachments: [cat], quote: null, suggested: false }]);
  await assert.rejects(host.call("chat.send", { chat: "main", text: "hi", timezone: "UTC", attachments: [{ ...cat, size: 1 }] }), /file f-cat was not uploaded here/);
  const { entities } = await host.call("session.history", { chat: "main", before: 100, limit: 100 });
  assert.equal(entities.length, 1, "a refused send records nothing");
});

test("a task: handed to a helper, its plan kept, told more while it works, asked, and ended with a result; or stopped", async () => {
  const started: string[] = [];
  const stopped: string[] = [];
  const { ports, io } = capture();
  const host = createHost({ ...ports, task: (task) => void started.push(task.title), stopTask: (id) => void stopped.push(id) }, { timers: manualTime("2026-10-20T08:00:00Z").timers });
  await host.call("chat.send", { chat: "main", text: "compare the three offers", timezone: "UTC", attachments: [] });
  const agent = io();
  assert.ok(agent);
  const made = agent.act({ kind: "task", title: "Compare offers", instructions: "Read the three offers in user/ and compare price and terms" });
  assert.ok(made.ok);
  assert.deepEqual(started, ["Compare offers"]);
  assert.ok(agent.act({ kind: "taskSteps", id: made.id, steps: [{ label: "Read the offers", done: true }, { label: "Compare", done: false }] }).ok);
  const heard: string[] = [];
  agent.listen(made.id, (m) => heard.push(m.kind === "instruction" ? m.text : "stop"));
  assert.ok(agent.act({ kind: "instruct", run: made.id, text: "Also note the delivery dates" }).ok);
  assert.deepEqual(heard, ["Also note the delivery dates"]);
  const asked = agent.act({ kind: "question", run: made.id, text: "Which currency?" });
  assert.ok(asked.ok);
  const answer = agent.answer(asked.id);
  assert.ok(agent.act({ kind: "taskEnded", id: made.id, status: "completed", result: "B is cheapest" }).ok);
  assert.deepEqual(await answer, { kind: "closed" }, "its open question closes with it");
  const { entities } = await host.call("session.history", { chat: "main", before: 100, limit: 100 });
  const task = entities.find((e) => e.id === made.id);
  assert.equal(task?.kind === "task" && `${task.status}: ${task.result} (${task.steps.length} steps)`, "completed: B is cheapest (2 steps)");

  const other = agent.act({ kind: "task", title: "Second", instructions: "x" });
  assert.ok(other.ok);
  assert.ok(agent.act({ kind: "stopRun", run: other.id }).ok);
  assert.deepEqual(stopped, [other.id]);
  assert.deepEqual(agent.act({ kind: "taskEnded", id: other.id, status: "completed", result: "late" }), { ok: false, rejection: { kind: "invalid", action: "taskEnded", from: "stopped" } });
});

test("a turn Amuse could not reply to is tried again once: the user's message as sent, or the note it was on", async () => {
  const turns: Turn[] = [];
  const { ports } = capture();
  const host = createHost({ ...ports, prompt: (turn, io) => void (turns.push(turn), (last = io)) });
  let last: AgentIO | undefined;
  await host.call("chat.send", { chat: "main", text: "summarize my mail", timezone: "UTC", attachments: [] });
  assert.ok(last);
  last.emit({ kind: "upserted", entity: { kind: "failure", id: "x1", at: "2026-10-20T08:00:00Z", reason: "refused", detail: "content_filter", turn: { kind: "message" }, status: "open" } });
  last.emit({ kind: "upserted", entity: { kind: "failure", id: "x2", at: "2026-10-20T08:00:00Z", reason: "failed", detail: "502", turn: { kind: "note", text: "[task done] found 3 offers" }, status: "open" } });
  await host.call("chat.retry", { id: "x1" });
  await host.call("chat.retry", { id: "x2" });
  assert.deepEqual(turns.slice(1), [
    { kind: "message", text: "summarize my mail", attachments: [], quote: null, suggested: false },
    { kind: "note", text: "[task done] found 3 offers" },
  ]);
  await assert.rejects(host.call("chat.retry", { id: "x1" }), /cannot retry from retried/);
});

test("a reply with nothing in it (no words, no files) never reaches the chat; a file alone does", async () => {
  const { ports, io } = capture();
  const host = createHost(ports);
  await host.call("chat.send", { chat: "main", text: "anything new?", timezone: "UTC", attachments: [] });
  const agent = io();
  assert.ok(agent);
  const at = "2026-10-20T08:00:00Z";
  agent.emit({ kind: "upserted", entity: { kind: "reply", id: "r1", at, text: "", streaming: false, attachments: [], suggestions: [], chosen: null } });
  agent.emit({ kind: "upserted", entity: { kind: "reply", id: "r2", at, text: " \n\t ", streaming: false, attachments: [], suggestions: [], chosen: null } });
  agent.emit({ kind: "upserted", entity: { kind: "reply", id: "r3", at, text: "", streaming: false, attachments: [{ id: "f1", name: "a.txt", type: "text/plain", size: 1, path: "user/a.txt" }], suggestions: [], chosen: null } });
  agent.emit({ kind: "upserted", entity: { kind: "reply", id: "r4", at, text: "Nothing new.", streaming: false, attachments: [], suggestions: [], chosen: null } });
  const { entities } = await host.call("session.history", { chat: "main", before: 100, limit: 100 });
  assert.deepEqual(entities.filter((e) => e.kind === "reply").map((e) => e.id), ["r3", "r4"]);
});

test("work handed off is looked in on: the chat agent hears how a task goes every ten minutes while it runs, and no more once it ends", async () => {
  const time = manualTime("2026-10-20T08:00:00Z");
  const notes: string[] = [];
  const { ports, io } = capture();
  const host = createHost(
    { ...ports, prompt: (turn, agent) => (turn.kind === "note" ? void notes.push(turn.text) : ports.prompt(turn, agent)) },
    { clock: time.clock, timers: time.timers },
  );
  await host.call("chat.send", { chat: "main", text: "compare the offers", timezone: "UTC", attachments: [] });
  const agent = io();
  assert.ok(agent);
  const made = agent.act({ kind: "task", title: "Compare offers", instructions: "Compare them" });
  assert.ok(made.ok);
  assert.ok(agent.act({ kind: "taskSteps", id: made.id, steps: [{ label: "Read", done: true }, { label: "Compare", done: false }] }).ok);
  time.advance(9 * 60_000);
  assert.deepEqual(notes, [], "not before ten minutes");
  time.advance(60_000);
  assert.equal(notes.length, 1);
  assert.match(notes[0] ?? "", /\[heartbeat\] Your task "Compare offers" .* has been going 10 minutes; it is \w+, 1 of 2 steps done \(next: Compare\)/);
  time.advance(10 * 60_000);
  assert.equal(notes.length, 2);
  assert.match(notes[1] ?? "", /going 20 minutes/);
  assert.ok(agent.act({ kind: "taskEnded", id: made.id, status: "completed", result: "B" }).ok);
  time.advance(30 * 60_000);
  assert.equal(notes.length, 2, "an ended task is not looked in on");
});

test("what is running comes with every turn: a browser task that needs the user, is taken over and handed back, then a task with a plan", async () => {
  const time = manualTime("2026-10-20T08:00:00Z");
  const { ports, io } = capture();
  const host = createHost(ports, { clock: time.clock, timers: time.timers });
  await host.call("chat.send", { chat: "main", text: "sign me in to the training site", timezone: "UTC", attachments: [] });
  const agent = io();
  assert.ok(agent);
  assert.equal(agent.running(), "", "nothing is running yet");
  const made = agent.act({ kind: "browse", title: "SHAPE training", url: "https://sso.example/login", instructions: "Sign in and open the next module", files: [] });
  assert.ok(made.ok);
  assert.ok(agent.act({ kind: "browserStep", id: made.id, step: "Opening the login page" }).ok);
  assert.match(agent.running(), /^What is running now:\n- browser task "SHAPE training" \(b-[\w-]+\): running, now "Opening the login page" \(just now\)$/);
  // it stops at the sign-in and asks the user
  assert.ok(agent.act({ kind: "browserStatus", id: made.id, status: "needs_you" }).ok);
  assert.ok(agent.act({ kind: "browserStep", id: made.id, step: "Waiting for you to sign in" }).ok);
  time.advance(60_000);
  assert.match(agent.running(), /: waiting for the user, now "Waiting for you to sign in" \(1 minute ago\)$/);
  // the user takes it
  await host.call("browser.control", { id: made.id, action: "take" });
  time.advance(2 * 60_000);
  assert.match(agent.running(), /: under the user's control \(2 minutes ago\)$/);
  // and hands it back: its agent carries on from where it was
  await host.call("browser.control", { id: made.id, action: "handBack" });
  assert.ok(agent.act({ kind: "browserStep", id: made.id, step: "进入下一节（2.02）" }).ok);
  assert.match(agent.running(), /: running, now "进入下一节（2.02）" \(just now\)$/);
  // a task's plan reads as its progress, and both stand together
  const task = agent.act({ kind: "task", title: "Compare offers", instructions: "Compare them" });
  assert.ok(task.ok);
  assert.ok(agent.act({ kind: "taskSteps", id: task.id, steps: [{ label: "Read", done: true }, { label: "Compare", done: false }] }).ok);
  assert.match(agent.running(), /^- task "Compare offers" \(t-[\w-]+\): running, 1 of 2 steps done \(just now\)$/m);
  assert.match(agent.running(), /SHAPE training/);
  // once a run is over it is not running any more
  assert.ok(agent.act({ kind: "released", id: made.id }).ok);
  assert.doesNotMatch(agent.running(), /SHAPE training/);
  assert.ok(agent.act({ kind: "taskEnded", id: task.id, status: "completed", result: "B" }).ok);
  assert.equal(agent.running(), "");
});

test("a note that must not wake the agent is kept for its next turn: a browser taken over, or handed back", async () => {
  const turns: Turn[] = [];
  const { ports, io } = capture();
  const host = createHost({ ...ports, prompt: (turn, agent) => void (turns.push(turn), ports.prompt(turn, agent)) });
  await host.call("chat.send", { chat: "main", text: "sign me in", timezone: "UTC", attachments: [] });
  const agent = io();
  assert.ok(agent);
  agent.mention('[browser task "SHAPE training" (b-1): the user took control]');
  assert.deepEqual(turns.at(-1), { kind: "aside", text: '[browser task "SHAPE training" (b-1): the user took control]' }, "not a note: a note would wake the agent");
});

test("a Connect card still waiting is connected once its app has an account connected since, however it got one; the agent hears", async () => {
  const notes: string[] = [];
  const { ports, io } = capture();
  const gmail = { id: "gmail", name: "Gmail", description: "", logo: null };
  // the user's first Gmail, from before: the card is for another one
  const accounts: Account[] = [{ id: "ca_0", app: gmail, label: "old@a.com", status: "active", since: "2020-01-01T00:00:00Z" }];
  const host = createHost(
    {
      ...ports,
      prompt: (turn, agent) => (turn.kind === "note" ? void notes.push(turn.text) : ports.prompt(turn, agent)),
      apps: { ...ports.apps, accounts: async () => accounts },
    },
    { timers: manualTime("2026-10-20T08:00:00Z").timers },
  );
  await host.call("chat.send", { chat: "main", text: "read my mail", timezone: "UTC", attachments: [] });
  const agent = io();
  assert.ok(agent);
  const card = agent.act({ kind: "connect", provider: "gmail", title: "Gmail" });
  const other = agent.act({ kind: "connect", provider: "slack", title: "Slack" });
  assert.ok(card.ok && other.ok);
  const status = async (id: string) => {
    const { entities } = await host.call("session.history", { chat: "main", before: 100, limit: 100 });
    const found = entities.find((e) => e.id === id);
    return found?.kind === "connection" ? found.status : null;
  };
  await host.call("apps.accounts", {});
  assert.equal(await status(card.id), "pending", "an account there before the card is not the one it asked for");
  accounts.push({ id: "ca_1", app: gmail, label: "me@a.com", status: "active", since: new Date().toISOString() });
  await host.call("apps.accounts", {});
  assert.equal(await status(card.id), "connected");
  assert.equal(await status(other.id), "pending", "an app without an account still waits");
  assert.deepEqual(notes, ["[connection] Gmail is connected now. Tell the user so in a short line; if something was waiting on it, carry on with it."]);
  await host.call("apps.accounts", {});
  assert.equal(notes.length, 1, "once");
});

test("an app that takes the user's key connects with it, and the Connect card waiting for it settles; the key reaches only the connector", async () => {
  const notes: string[] = [];
  const keys: string[] = [];
  const { ports, io } = capture();
  const cloudflare = { id: "cloudflare", name: "Cloudflare", description: "", logo: null };
  const accounts: Account[] = [];
  const host = createHost(
    {
      ...ports,
      prompt: (turn, agent) => (turn.kind === "note" ? void notes.push(turn.text) : ports.prompt(turn, agent)),
      apps: {
        ...ports.apps,
        accounts: async () => accounts,
        access: async () => ({ kind: "key", fields: [{ name: "generic_api_key", label: "API Token", secret: true }] }),
        connectKey: async (_app, values) => {
          keys.push(...values.map((v) => v.value));
          accounts.push({ id: "ca_1", app: cloudflare, label: null, status: "active", since: new Date().toISOString() });
        },
      },
    },
    { timers: manualTime("2026-10-20T08:00:00Z").timers },
  );
  await host.call("chat.send", { chat: "main", text: "check my DNS", timezone: "UTC", attachments: [] });
  const agent = io();
  assert.ok(agent);
  const card = agent.act({ kind: "connect", provider: "cloudflare", title: "Cloudflare" });
  assert.ok(card.ok);
  assert.deepEqual(await host.call("apps.access", { app: "cloudflare" }), { access: { kind: "key", fields: [{ name: "generic_api_key", label: "API Token", secret: true }] } });
  await host.call("apps.connectKey", { app: "cloudflare", values: [{ name: "generic_api_key", value: "token-123" }] });
  assert.deepEqual(keys, ["token-123"]);
  const { entities } = await host.call("session.history", { chat: "main", before: 100, limit: 100 });
  const settled = entities.find((e) => e.id === card.id);
  assert.equal(settled?.kind === "connection" ? settled.status : null, "connected");
  assert.equal(notes.length, 1);
  // not in the conversation the agent reads
  assert.equal(JSON.stringify(entities).includes("token-123") || notes.join().includes("token-123"), false);
});

test("every approval asked, in any chat, is listed newest first with its chat, and an answer for good says so", async () => {
  const time = manualTime("2026-10-20T08:00:00Z");
  const { ports, io } = capture();
  const host = createHost(ports, { clock: time.clock, timers: time.timers });
  await host.call("chat.send", { chat: "main", text: "send it", timezone: "UTC", attachments: [] });
  const main = io();
  assert.ok(main);
  const first = main.act({ kind: "ask", action: "Send the email", target: "me@a.com", detail: "To: x", remember: true, app: "gmail" });
  assert.ok(first.ok);
  await host.call("approval.resolve", { id: first.id, resolution: "allow_always" });
  time.advance(60_000);
  const side = await host.call("chats.create", {});
  await host.call("chat.send", { chat: side.id, text: "and visit", timezone: "UTC", attachments: [] });
  const other = io();
  assert.ok(other);
  const second = other.act({ kind: "ask", action: "Visit", target: "news.example", detail: "to read", remember: true });
  assert.ok(second.ok);
  const { approvals } = await host.call("approvals.list", {});
  assert.deepEqual(
    approvals.map((a) => [a.chat.id, a.approval.action, a.approval.status, a.approval.always, a.approval.app]),
    [
      [side.id, "Visit", "pending", false, null],
      ["main", "Send the email", "approved", true, "gmail"],
    ],
  );
});

test("the sandbox is reset when the user asks; with none on the server they are told so", async () => {
  const { ports } = capture();
  await assert.rejects(createHost(ports).call("sandbox.reset", {}), /no sandbox/);
  let wiped = 0;
  const host = createHost({ ...ports, sandbox: { ...noSandbox, reset: async () => void wiped++ } });
  assert.equal(await host.call("sandbox.reset", {}), null);
  assert.equal(wiped, 1);
});

test("a temporary code the user gives goes to its terminal alone: not the chat, its record or what the agent hears", async () => {
  const notes: string[] = [];
  const typed: { name: string; value: string }[] = [];
  const { ports, io } = capture();
  const host = createHost({
    ...ports,
    prompt: (turn, agent) => (turn.kind === "note" ? void notes.push(turn.text) : ports.prompt(turn, agent)),
    secrets: { ...noSecrets, answer: async (request, answer) => void (answer.kind === "temporary" && typed.push({ name: request.name, value: answer.value })) },
  });
  await host.call("chat.send", { chat: "main", text: "log in to the CLI", timezone: "UTC", attachments: [] });
  const agent = io();
  assert.ok(agent);
  const asked = agent.act({ kind: "askSecret", name: "Login code", why: "the CLI waits for it", deliver: { kind: "temporary", pane: "w1:p2" } });
  assert.ok(asked.ok);
  await host.call("secret.answer", { id: asked.id, answer: { kind: "temporary", value: "code-very-secret" } });
  assert.deepEqual(typed, [{ name: "Login code", value: "code-very-secret" }]);
  const { entities } = await host.call("session.history", { chat: "main", before: 100, limit: 100 });
  const request = entities.find((e) => e.id === asked.id);
  assert.equal(request?.kind === "secret" ? request.status : null, "provided");
  assert.doesNotMatch(JSON.stringify(entities), /code-very-secret/);
  assert.equal(notes.length, 1);
  assert.doesNotMatch(notes[0] ?? "", /code-very-secret/);
  await assert.rejects(host.call("secret.answer", { id: asked.id, answer: { kind: "temporary", value: "again" } }), /answered already/);

  const declined = agent.act({ kind: "askSecret", name: "API key", why: "a tool needs it", deliver: { kind: "stored", plain: [], secret: [{ name: "key", kind: "text", role: null }], note: "", uses: [{ kind: "env", field: "key", name: "TOOL_KEY" }] } });
  assert.ok(declined.ok);
  await host.call("secret.answer", { id: declined.id, answer: null });
  assert.equal(typed.length, 1, "nothing is given when declined");
  assert.match(notes[1] ?? "", /declined/);
});

test("an answer must fit its card: a code for a code, the asked fields (as lines or files) for a long-term secret", async () => {
  const stored: string[] = [];
  const { ports, io } = capture();
  const host = createHost({ ...ports, secrets: { ...noSecrets, answer: async (request) => void stored.push(request.name) } });
  await host.call("chat.send", { chat: "main", text: "hi", timezone: "UTC", attachments: [] });
  const agent = io();
  assert.ok(agent);
  const text: FieldValue = { kind: "text", text: "my-project" };
  const asked = agent.act({
    kind: "askSecret",
    name: "Cloud account",
    why: "to deploy",
    deliver: { kind: "stored", plain: [{ name: "project", role: null, value: text }], secret: [{ name: "key.json", kind: "file", role: null }], note: "", uses: [] },
  });
  assert.ok(asked.ok);
  await assert.rejects(host.call("secret.answer", { id: asked.id, answer: { kind: "temporary", value: "123456" } }), /asks for the fields/);
  await assert.rejects(host.call("secret.answer", { id: asked.id, answer: { kind: "stored", secret: [] } }), /key.json is missing/);
  await assert.rejects(
    host.call("secret.answer", { id: asked.id, answer: { kind: "stored", secret: [{ name: "key.json", value: text }] } }),
    /should be a file/,
  );
  assert.deepEqual(stored, []);
  const file: FieldValue = { kind: "file", filename: "key.json", content: btoa("{}") };
  await host.call("secret.answer", { id: asked.id, answer: { kind: "stored", secret: [{ name: "key.json", value: file }] } });
  assert.deepEqual(stored, ["Cloud account"]);
});

test("a card for the key of a service is settled when the key appears, however it got there, with its end shown and the agent woken; dismissed, nothing is said", async () => {
  const notes: string[] = [];
  let connected = false;
  let changed: () => void = () => {};
  const { ports, io } = capture();
  const keys: Keys = {
    ...noKeys,
    list: async () => ({ ...(await noKeys.list()), providers: [{ id: "openrouter", name: "OpenRouter", use: "models", connected, way: connected ? "key" : null, hint: connected ? "…a1b2" : null, account: null, guide: null }] }),
    onChange: (listener) => void (changed = listener),
  };
  const host = createHost({ ...ports, keys, prompt: (turn, agent) => (turn.kind === "note" ? void notes.push(turn.text) : ports.prompt(turn, agent)) });
  await host.call("chat.send", { chat: "main", text: "use openrouter", timezone: "UTC", attachments: [] });
  const agent = io();
  assert.ok(agent);
  const wanted = agent.act({ kind: "askSecret", name: "OpenRouter", why: "for its models", deliver: { kind: "key", provider: "openrouter", hint: null } });
  const dismissed = agent.act({ kind: "askSecret", name: "Another", why: "x", deliver: { kind: "key", provider: "another", hint: null } });
  assert.ok(wanted.ok && dismissed.ok);
  const status = async (id: string) => {
    const { entities } = await host.call("session.history", { chat: "main", before: 100, limit: 100 });
    const found = entities.find((e) => e.id === id);
    return found?.kind === "secret" ? { status: found.status, hint: found.deliver.kind === "key" ? found.deliver.hint : undefined } : null;
  };
  // the key is not there: a change of other keys settles nothing
  changed();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await status(wanted.id), { status: "pending", hint: null });
  // dismissed with "not now": declined, and the agent hears nothing
  await host.call("secret.answer", { id: dismissed.id, answer: null });
  assert.deepEqual(await status(dismissed.id), { status: "declined", hint: null });
  assert.deepEqual(notes, []);
  // the key appears (through the card's sheet, or Settings: the host cannot tell)
  connected = true;
  changed();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await status(wanted.id), { status: "provided", hint: "…a1b2" });
  assert.equal(notes.length, 1);
  assert.match(notes[0] ?? "", /added the key of OpenRouter/);
  // a card answered is not answered again by a later change
  changed();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notes.length, 1);
  // and a key does not come in as an answer to the card
  await assert.rejects(host.call("secret.answer", { id: wanted.id, answer: { kind: "temporary", value: "x" } }), /answered already/);
});

test("the browser's rules are listed with their defaults and what the user chose, and a site's exceptions are kept as a whole", async () => {
  const { ports } = capture();
  const host = createHost(ports);
  assert.deepEqual((await host.call("browser.rules", {})).rules, [
    { action: "visit", permission: "ask", chosen: false },
    { action: "submit", permission: "ask", chosen: false },
    { action: "download", permission: "allow", chosen: false },
    { action: "upload", permission: "ask", chosen: false },
  ]);
  await host.call("browser.permit", { action: "submit", permission: "deny" });
  await host.call("browser.permit", { action: "download", permission: "ask" });
  assert.deepEqual(
    (await host.call("browser.rules", {})).rules.map((r) => `${r.action} ${r.permission}${r.chosen ? "*" : ""}`),
    ["visit ask", "submit deny*", "download ask*", "upload ask"],
  );
  await host.call("browser.permit", { action: "submit", permission: null });
  assert.deepEqual((await host.call("browser.rules", {})).rules[1], { action: "submit", permission: "ask", chosen: false });

  await host.call("sites.permit", { site: "bank.com", rule: { never: true, actions: {} } });
  await host.call("sites.permit", { site: "a5.ucsd.edu", rule: { never: false, actions: { visit: "allow", submit: "allow" } } });
  assert.deepEqual((await host.call("sites.rules", {})).rules, [
    { site: "a5.ucsd.edu", never: false, actions: { visit: "allow", submit: "allow" } },
    { site: "bank.com", never: true, actions: {} },
  ]);
  await host.call("sites.permit", { site: "bank.com", rule: null });
  await host.call("sites.permit", { site: "a5.ucsd.edu", rule: { never: false, actions: {} } });
  assert.deepEqual((await host.call("sites.rules", {})).rules, [], "a site with nothing set is none");
});

test("a refusal by the user's rule is an approval that ends denied, marked as the rule's; it is listed with the others and cannot be answered", async () => {
  const time = manualTime("2026-10-20T08:00:00Z");
  const { ports, io } = capture();
  const host = createHost(ports, { clock: time.clock, timers: time.timers });
  await host.call("chat.send", { chat: "main", text: "mail them", timezone: "UTC", attachments: [] });
  const agent = io();
  assert.ok(agent);
  const refused = agent.act({ kind: "refuse", action: "Email x@y.z", target: "me@a.com", detail: "Your rule for Gmail (Write permissions: Deny)", app: "gmail" });
  assert.ok(refused.ok);
  const asked = agent.act({ kind: "ask", action: "Visit", target: "news.example", detail: "to read", remember: true });
  assert.ok(asked.ok);
  const { approvals } = await host.call("approvals.list", {});
  const record = approvals.find((a) => a.approval.id === refused.id)?.approval;
  assert.deepEqual(record && { status: record.status, byRule: record.byRule, remember: record.remember, app: record.app, target: record.target }, {
    status: "denied",
    byRule: true,
    remember: false,
    app: "gmail",
    target: "me@a.com",
  });
  assert.equal(approvals.find((a) => a.approval.id === asked.id)?.approval.byRule, false);
  await assert.rejects(host.call("approval.resolve", { id: refused.id, resolution: "allow_once" }), /cannot resolve from denied/);
});

test("a journal is replayed as it is read, and the host keeps only the latest events to catch a client up", async () => {
  const total = 2500;
  let produced = 0;
  const quiet: Envelope["event"] = { kind: "activity", activity: null };
  const events = function* (): Generator<Envelope> {
    for (let seq = 1; seq <= total; seq++) {
      produced += 1;
      yield { seq, event: quiet };
    }
  };
  const base = memoryChats();
  const store = { ...base, journal: (chat: string) => (chat === "main" ? { load: () => events(), append: () => {} } : base.journal(chat)) };
  const idle: Timers<number> = { set: () => 0, clear: () => {} };
  const host = createHost(capture().ports, { store, timers: idle });
  assert.equal(produced, total, "every event was read, one at a time");
  const near = await host.call("session.sync", { chat: "main", since: total - 5 });
  assert.ok(near.kind === "events" && near.events.length === 5 && near.events[0]?.seq === total - 4);
  const far = await host.call("session.sync", { chat: "main", since: 10 });
  assert.ok(far.kind === "snapshot" && far.state.seq === total, "too far behind for the events kept: a snapshot");
  const current = await host.call("session.sync", { chat: "main", since: total });
  assert.ok(current.kind === "events" && current.events.length === 0);
});

test("a reply to a card reaches the agent with the card quoted, and the recorded message keeps the quote", async () => {
  const turns: Turn[] = [];
  const { ports, io } = capture();
  const host = createHost({ ...ports, prompt: (turn, agent) => (turns.push(turn), ports.prompt(turn, agent)) }, { timers: manualTime("2026-10-20T08:00:00Z").timers });
  await host.call("chat.send", { chat: "main", text: "brief me every morning", timezone: "UTC", attachments: [] });
  const made = io()?.act({ kind: "schedule", title: "Morning briefing", instructions: "Read the mail", when: { kind: "repeat", cron: "0 8 * * *", timezone: "UTC" } });
  assert.ok(made?.ok);
  const quote = { id: made.id, kind: "schedule", text: "Morning briefing", state: "active" };
  const { id } = await host.call("chat.send", { chat: "main", text: "make it 9", timezone: "UTC", attachments: [], replyTo: made.id });
  assert.deepEqual(turns.at(-1), { kind: "message", text: "make it 9", attachments: [], quote, suggested: false });
  const { entities } = await host.call("session.history", { chat: "main", before: 100, limit: 100 });
  const recorded = entities.find((e) => e.id === id);
  assert.ok(recorded?.kind === "prompt");
  assert.deepEqual(recorded.quote, quote);
  await assert.rejects(host.call("chat.send", { chat: "main", text: "and this", timezone: "UTC", attachments: [], replyTo: "gone" }), /not found/);
});

test("a message about an error reaches the agent with the error and its detail, and the recorded message keeps them", async () => {
  const turns: Turn[] = [];
  const { ports } = capture();
  const host = createHost({ ...ports, prompt: (turn, agent) => (turns.push(turn), ports.prompt(turn, agent)) }, { timers: manualTime("2026-10-20T08:00:00Z").timers });
  const about = { message: "Voice needs a key", detail: "code: transcribe_no_key; feature: voice transcription" };
  const { id } = await host.call("chat.send", { chat: "main", text: "I ran into this", timezone: "UTC", attachments: [], about });
  const turn = turns.at(-1);
  assert.ok(turn?.kind === "message" && turn.quote?.kind === "error");
  assert.deepEqual([turn.quote.text, turn.quote.detail], [about.message, about.detail]);
  const { entities } = await host.call("session.history", { chat: "main", before: 100, limit: 100 });
  const recorded = entities.find((e) => e.id === id);
  assert.ok(recorded?.kind === "prompt" && recorded.quote?.kind === "error");
  assert.equal(recorded.quote.text, about.message);
});

test("a helper's context has an old long reply whole; the chat turn's own window has it shortened", async () => {
  const { ports, io } = capture();
  const host = createHost(ports);
  const at = "2026-10-20T08:00:00Z";
  const say = (id: string, text: string) => io()?.emit({ kind: "upserted", entity: { kind: "reply", id, at, text, streaming: false, attachments: [], suggestions: [], chosen: null } });
  await host.call("chat.send", { chat: "main", text: "draft the mail", timezone: "UTC", attachments: [] });
  say("draft", `Dear Li,\n\n${"p".repeat(600)}\n\nBest, ${"q".repeat(500)} end-of-draft`);
  // enough chat after it to close its block and one more, with the latest replies after it
  for (let i = 0; i < 8; i++) {
    await host.call("chat.send", { chat: "main", text: `${i} ${"u".repeat(1_000)}`, timezone: "UTC", attachments: [] });
    say(`r${i}`, `${i} ${"a".repeat(1_000)}`);
  }
  const agent = io();
  assert.ok(agent);
  assert.match(agent.context(), /end-of-draft/, "a helper, or read_chat, has the draft whole");
  assert.doesNotMatch(agent.context("chat"), /end-of-draft/, "the chat turn's window has it shortened");
  assert.match(agent.context("chat"), /Dear Li,/);
});
