import assert from "node:assert/strict";
import { test } from "node:test";
import type { Turn } from "@amuse/core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { chat } from "./scripted-chat.ts";

const note: Turn = { kind: "note", text: "[browser task b-1 completed] logged in" };

test("a note turn shows nothing it ends with, whatever the model writes there", async () => {
  // the word a model used to write instead of calling the old no_reply tool, and a sentence it might add
  const { agent, io, faux, replies, until } = await chat([fauxAssistantMessage("no_reply")]);
  agent.prompt(note, io);
  await until(1);
  assert.deepEqual(replies(), [], "the name of a tool it meant to call is not a message");
  agent.prompt(note, io);
  await until(2);
  assert.deepEqual(replies(), [], "nor is a sentence saying there is nothing to say");
  assert.equal(faux.state.callCount, 2);
});

test("a note turn reaches the user only with say", async () => {
  const { agent, io, replies, until } = await chat([
    fauxAssistantMessage(fauxToolCall("say", { text: "The mail checker found one that needs you." }), { stopReason: "toolUse" }),
    fauxAssistantMessage("(wrapping up my own notes)"),
  ]);
  agent.prompt(note, io);
  await until(1);
  assert.deepEqual(replies(), ["The mail checker found one that needs you."], "what say says, and nothing else");
});

test("a message from the user replies with what the turn ends with, and a blank reply is not one", async () => {
  const { agent, io, replies, until } = await chat([fauxAssistantMessage("Logged in."), fauxAssistantMessage("  \n ")]);
  agent.prompt(asked, io);
  await until(1);
  agent.prompt(asked, io);
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
