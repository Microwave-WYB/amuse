import assert from "node:assert/strict";
import { test } from "node:test";
import type { Turn } from "@amuse/core";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { chat } from "./scripted-chat.ts";

const note: Turn = { kind: "note", text: "[browser task b-1 completed] logged in" };

test("no_reply ends a turn without a reply, and nothing the model wrote in it reaches the chat", async () => {
  const { agent, io, faux, replies, until } = await chat([
    fauxAssistantMessage([fauxText("(No reply needed: already reported.)"), fauxToolCall("no_reply", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage("Never asked for"),
  ]);
  agent.prompt(note, io);
  await until(1);
  assert.deepEqual(replies(), []);
  assert.equal(faux.state.callCount, 1, "the model is not called again for a turn that stays silent");
});

test("what the model writes after no_reply in the same turn is dropped too", async () => {
  const lookup = defineTool({
    name: "lookup",
    label: "Look up",
    description: "Look something up",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "found" }], details: null };
    },
  });
  // a tool that does not end the turn alongside it: the model is called again, and what it then writes is not shown
  const { agent, io, replies, until } = await chat(
    [fauxAssistantMessage([fauxToolCall("no_reply", {}), fauxToolCall("lookup", {})], { stopReason: "toolUse" }), fauxAssistantMessage("Nothing new for you.")],
    { tools: [lookup] },
  );
  agent.prompt(note, io);
  await until(1);
  assert.deepEqual(replies(), []);
});

test("a turn that does not call no_reply replies as before, and a blank reply is not one", async () => {
  const { agent, io, replies, until } = await chat([fauxAssistantMessage("Logged in."), fauxAssistantMessage("  \n ")]);
  agent.prompt(note, io);
  await until(1);
  agent.prompt(note, io);
  await until(2);
  assert.deepEqual(replies(), ["Logged in."]);
});

const asked: Turn = { kind: "message", text: "Can you book it?", attachments: [], quote: null };

test("suggest_replies puts the options on the reply that follows it, and on that one alone", async () => {
  const { agent, io, until, said } = await chat([
    fauxAssistantMessage(fauxToolCall("suggest_replies", { options: ["Book it", " Not now ", "Book it"] }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Shall I book it?"),
  ]);
  agent.prompt(asked, io);
  await until(1);
  assert.deepEqual(
    said.flatMap((s) => (s.kind === "upserted" && s.entity.kind === "reply" ? [[s.entity.text, s.entity.suggestions, s.entity.chosen]] : [])),
    [["Shall I book it?", ["Book it", "Not now"], null]],
  );
});

test("suggest_replies with fewer than two different options attaches nothing", async () => {
  const { agent, io, until, said } = await chat([
    fauxAssistantMessage(fauxToolCall("suggest_replies", { options: ["Yes", "Yes"] }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Shall I?"),
  ]);
  agent.prompt(asked, io);
  await until(1);
  assert.deepEqual(
    said.flatMap((s) => (s.kind === "upserted" && s.entity.kind === "reply" ? [s.entity.suggestions] : [])),
    [[]],
  );
});

test("a reply that is only the word no_reply (written, not called) is not shown either", async () => {
  const { agent, io, replies, until } = await chat([fauxAssistantMessage("</think>\nno_reply")]);
  agent.prompt(note, io);
  await until(1);
  assert.deepEqual(replies(), []);
});

test("a turn the user wrote to has no no_reply at all: the word, written, is a reply like any other", async () => {
  const { agent, io, replies, until } = await chat([fauxAssistantMessage("no_reply")]);
  agent.prompt(asked, io);
  await until(1);
  assert.deepEqual(replies(), ["no_reply"]);
});
