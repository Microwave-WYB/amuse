import assert from "node:assert/strict";
import { test } from "node:test";
import type { Schedule } from "@amuse/protocol";
import { type TranscriptContext, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { chat } from "./scripted-chat.ts";
import { scheduleLine, whenOf, worthRunning } from "./schedules.ts";

test("a schedule's time is the user's: a cron in their zone, a one-off read on their clock", () => {
  assert.deepEqual(whenOf({ cron: "0 8 * * *" }, "Asia/Shanghai"), { ok: true, when: { kind: "repeat", cron: "0 8 * * *", timezone: "Asia/Shanghai" } });
  assert.deepEqual(whenOf({ at: "2026-10-21 08:00" }, "Asia/Shanghai"), { ok: true, when: { kind: "once", at: "2026-10-21T00:00:00.000Z" } });
  assert.deepEqual(whenOf({ cron: "0 9 * * 1", timezone: "Europe/Paris" }, "Asia/Shanghai"), { ok: true, when: { kind: "repeat", cron: "0 9 * * 1", timezone: "Europe/Paris" } });
  assert.equal(whenOf({}, "UTC").ok, false);
  assert.equal(whenOf({ cron: "0 8 * * *", at: "2026-10-21 08:00" }, "UTC").ok, false);
  assert.equal(whenOf({ at: "tomorrow" }, "UTC").ok, false);
});

test("a run waits for what it needs: new conversation, or a conversation gone quiet and a few hours since the last", () => {
  const base: Schedule = {
    kind: "schedule",
    id: "s-mem",
    at: "2026-10-21T00:00:00Z",
    title: "Memory",
    instructions: "Tidy memory",
    when: { kind: "repeat", cron: "0 * * * *", timezone: "UTC" },
    status: "active",
    next: null,
    running: true,
    last: { at: "2026-10-21T10:00:00Z", outcome: "quiet", summary: "" },
    needs: "conversation",
    preset: true,
    goal: null,
  };
  const chats = (updated: string) => [{ updated: "2026-10-20T00:00:00Z" }, { updated }];
  assert.equal(worthRunning(base, chats("2026-10-21T09:00:00Z"), "2026-10-21T11:00:00Z"), false, "nothing since the last run");
  assert.equal(worthRunning(base, chats("2026-10-21T10:30:00Z"), "2026-10-21T11:00:00Z"), true);
  assert.equal(worthRunning({ ...base, needs: null }, chats("2026-10-21T09:00:00Z"), "2026-10-21T11:00:00Z"), true, "no condition");

  const lull: Schedule = { ...base, needs: "lull" };
  assert.equal(worthRunning(lull, chats("2026-10-21T13:50:00Z"), "2026-10-21T14:00:00Z"), false, "still talking");
  assert.equal(worthRunning(lull, chats("2026-10-21T11:00:00Z"), "2026-10-21T12:00:00Z"), false, "the last run was 2 hours ago");
  assert.equal(worthRunning(lull, chats("2026-10-21T13:30:00Z"), "2026-10-21T14:00:00Z"), true);
});

test("list_schedules gives every schedule in force with its full id, how it runs and when next, in the user's time; not those cancelled", async () => {
  const of = (id: string, title: string, status: Schedule["status"], next: string | null, preset = false): Schedule => ({
    kind: "schedule",
    id,
    at: "2026-10-21T00:00:00Z",
    title,
    instructions: "",
    when: { kind: "repeat", cron: "0 11,15,19,23 * * *", timezone: "America/Los_Angeles" },
    status,
    next,
    running: false,
    last: null,
    needs: null,
    preset,
    goal: null,
  });
  const schedules = [
    of("s-14ae8456-6b10-4cd4-bf2b-eece1689a9d9", "Project reminders", "active", "2026-10-22T18:00:00Z"),
    of("s-0a", "Old mail check", "cancelled", null),
    of("s-0b", "Memory", "paused", null, true),
  ];
  let listed = "";
  const { agent, io, until } = await chat(
    [
      fauxAssistantMessage(fauxToolCall("list_schedules", { status: "Looking" }), { stopReason: "toolUse" }),
      (context: TranscriptContext) => {
        const result = context.messages.findLast((m) => m.role === "toolResult");
        listed = result?.role === "toolResult" ? result.content.map((c) => (c.type === "text" ? c.text : "")).join("") : "";
        return fauxAssistantMessage("Two.");
      },
    ],
    { schedules },
  );
  agent.prompt({ kind: "message", text: "what is scheduled?", attachments: [], quote: null }, io);
  await until(1);
  assert.equal(
    listed,
    [
      "s-14ae8456-6b10-4cd4-bf2b-eece1689a9d9 | Project reminders | active | repeats 0 11,15,19,23 * * * (America/Los_Angeles) | next 2026-10-22 18:00",
      "s-0b | Memory | paused; built-in upkeep | repeats 0 11,15,19,23 * * * (America/Los_Angeles) | no next run",
    ].join("\n"),
  );
  const once: Schedule = { ...of("s-1", "Call", "active", "2026-10-22T16:00:00Z"), when: { kind: "once", at: "2026-10-22T16:00:00Z" } };
  assert.equal(scheduleLine(once, "Asia/Shanghai"), "s-1 | Call | active | once at 2026-10-23 00:00 | next 2026-10-23 00:00");
});

test("list_schedules with an id gives that schedule's instructions in full, so changing it loses nothing", async () => {
  const long = `Remind me at 8 to take ${"the blue pill, the white pill, ".repeat(12)}and the fish oil.`;
  const meds: Schedule = {
    kind: "schedule",
    id: "s-meds",
    at: "2026-10-21T00:00:00Z",
    title: "Medication",
    instructions: long,
    when: { kind: "repeat", cron: "0 8 * * *", timezone: "UTC" },
    status: "active",
    next: "2026-10-22T08:00:00Z",
    running: false,
    last: null,
    needs: null,
    preset: false,
    goal: null,
  };
  let listed = "";
  const { agent, io, until } = await chat(
    [
      fauxAssistantMessage(fauxToolCall("list_schedules", { status: "Looking", id: "s-meds" }), { stopReason: "toolUse" }),
      (context: TranscriptContext) => {
        const result = context.messages.findLast((m) => m.role === "toolResult");
        listed = result?.role === "toolResult" ? result.content.map((c) => (c.type === "text" ? c.text : "")).join("") : "";
        return fauxAssistantMessage("Done.");
      },
    ],
    { schedules: [meds] },
  );
  agent.prompt({ kind: "message", text: "add vitamin D to my medication reminder", attachments: [], quote: null }, io);
  await until(1);
  assert.ok(listed.startsWith("s-meds | Medication | active"));
  assert.ok(listed.endsWith(`Instructions (in full):\n${long}`));
});
