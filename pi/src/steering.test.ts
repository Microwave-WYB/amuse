import assert from "node:assert/strict";
import { test } from "node:test";
import { type AgentIO, type Turn, type Workspace, noWorkspace } from "@amuse/core";
import { type TranscriptContext, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type AgentSession, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { chat } from "./scripted-chat.ts";

/** What the user has said to the model so far, message by message. */
const userTexts = (context: TranscriptContext): string[] =>
  context.messages.flatMap((m) => (m.role === "user" ? [typeof m.content === "string" ? m.content : m.content.map((c) => (c.type === "text" ? c.text : "")).join("")] : []));

const message = (text: string): Turn => ({ kind: "message", text, attachments: [], quote: null });

/** A tool that holds the turn where it is (a long command) until the test lets it go. */
function slow() {
  let release: () => void = () => {};
  let begun: () => void = () => {};
  const running = new Promise<void>((resolve) => (begun = resolve));
  const held = new Promise<void>((resolve) => (release = resolve));
  const tool = defineTool({
    name: "wait",
    label: "Wait",
    description: "A long command",
    parameters: Type.Object({}),
    async execute() {
      begun();
      await held;
      return { content: [{ type: "text", text: "finished" }], details: null };
    },
  });
  return { tool, running, release };
}

/** The user sends while the agent is partway through: it is in the chat first, then reaches the agent. */
const interject = (conversation: string[], agent: { prompt(turn: Turn, io: AgentIO): void }, io: AgentIO, text: string) => {
  conversation.push(`[08:01] User: ${text}`);
  agent.prompt(message(text), io);
};

test("a message sent while a turn is under way reaches the model mid-turn, and the turn answers it: one run, no second", async () => {
  const { tool, running, release } = slow();
  const seen: string[][] = [];
  const { agent, io, faux, conversation, replies, until } = await chat(
    [
      fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
      (context) => {
        seen.push(userTexts(context));
        return fauxAssistantMessage("Done, and tomorrow too.");
      },
    ],
    { tools: [tool] },
  );
  agent.prompt(message("check today"), io);
  await running;
  interject(conversation, agent, io, "also check tomorrow");
  release();
  await until(1);
  assert.deepEqual(replies(), ["Done, and tomorrow too."]);
  assert.equal(faux.state.callCount, 2);
  const [texts] = seen;
  assert.equal(texts?.length, 2, "the brief, then the new message, once");
  assert.match(texts?.[0] ?? "", /User: hello/);
  assert.match(texts?.[1] ?? "", /^The user, while you were working:\nalso check tomorrow/, "said in words: brackets are for background notes");
});

test("a message that arrives as the model finishes is still read, once", async () => {
  const seen: string[][] = [];
  let sent = false;
  const sender: { send?: () => void } = {};
  const { agent, io, faux, conversation, replies, until } = await chat(
    [
      fauxAssistantMessage("First answer."),
      (context) => {
        seen.push(userTexts(context));
        return fauxAssistantMessage("Second answer.");
      },
    ],
    {
      opened: (session) => {
        // the loop has made its last look for new messages when it ends
        session.subscribe((event) => {
          if (event.type === "agent_end" && !sent) {
            sent = true;
            sender.send?.();
          }
        });
      },
    },
  );
  sender.send = () => interject(conversation, agent, io, "one more thing");
  agent.prompt(message("hello"), io);
  await until(1);
  assert.deepEqual(replies(), ["First answer.", "Second answer."]);
  assert.equal(faux.state.callCount, 2);
  assert.equal(seen[0]?.filter((t) => t.includes("one more thing")).length, 1);
});

const undelivered: { how: string; steer: AgentSession["steer"] }[] = [
  { how: "cannot be given to the model", steer: () => Promise.reject(new Error("the session is closed")) },
  { how: "is taken but the turn ends without reading it", steer: async () => "queued" },
];

for (const { how, steer } of undelivered) {
  test(`a message that ${how} becomes a turn of its own, after the one under way`, async () => {
    const { tool, running, release } = slow();
    const briefs: string[] = [];
    const { agent, io, faux, conversation, replies, until } = await chat(
      [
        fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
        fauxAssistantMessage("First answer."),
        (context) => {
          briefs.push(userTexts(context).join("\n"));
          return fauxAssistantMessage("Second answer.");
        },
      ],
      {
        tools: [tool],
        opened: (session: AgentSession) => {
          session.steer = steer;
        },
      },
    );
    agent.prompt(message("check today"), io);
    await running;
    interject(conversation, agent, io, "also check tomorrow");
    release();
    await until(2);
    assert.deepEqual(replies(), ["First answer.", "Second answer."]);
    assert.equal(faux.state.callCount, 3);
    assert.match(briefs[0] ?? "", /User: also check tomorrow/, "the new turn is given the chat with the message in it");
  });
}

test("a note from background work is not steered: it waits for the turn", async () => {
  const { tool, running, release } = slow();
  const seen: string[][] = [];
  const { agent, io, replies, until } = await chat(
    [
      fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
      (context) => {
        seen.push(userTexts(context));
        return fauxAssistantMessage("First answer.");
      },
      fauxAssistantMessage(fauxToolCall("no_reply", {}), { stopReason: "toolUse" }),
    ],
    { tools: [tool] },
  );
  agent.prompt(message("check today"), io);
  await running;
  agent.prompt({ kind: "note", text: "[task t-1 completed] done" }, io);
  release();
  await until(2);
  assert.equal(seen[0]?.length, 1, "the first turn never saw the note");
  assert.deepEqual(replies(), ["First answer."]);
});

test("a takeover note does not wake an idle agent: no turn, no session, and the next turn reads it", async () => {
  const seen: string[][] = [];
  const { agent, io, faux, conversation, replies, until } = await chat([
    (context) => {
      seen.push(userTexts(context));
      return fauxAssistantMessage("It is on the second module.");
    },
  ]);
  agent.prompt({ kind: "aside", text: '[browser task "SHAPE training" (b-1): the user took control]' }, io);
  agent.prompt({ kind: "aside", text: '[browser task "SHAPE training" (b-1): the user handed it back; it is carrying on]' }, io);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(replies(), [], "no turn of its own");
  assert.equal(faux.state.callCount, 0, "and no session opened for it");
  // the user asks how it is going
  conversation.push("[08:01] User: 在做了吗");
  agent.prompt(message("在做了吗"), io);
  await until(1);
  assert.deepEqual(replies(), ["It is on the second module."]);
  const brief = seen[0]?.[0] ?? "";
  assert.match(brief, /Since your last turn:\n\[browser task "SHAPE training" \(b-1\): the user took control\]\n\n\[browser task "SHAPE training" \(b-1\): the user handed it back; it is carrying on\]/, "both, in the order they happened");
});

test("a takeover note reaches a turn under way as it works: one run, no turn of its own", async () => {
  const { tool, running, release } = slow();
  const seen: string[][] = [];
  const { agent, io, faux, until } = await chat(
    [
      fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
      (context) => {
        seen.push(userTexts(context));
        return fauxAssistantMessage("Right, it is running.");
      },
    ],
    { tools: [tool] },
  );
  agent.prompt(message("check today"), io);
  await running;
  agent.prompt({ kind: "aside", text: '[browser task "SHAPE training" (b-1): the user handed it back; it is carrying on]' }, io);
  release();
  await until(1);
  assert.equal(faux.state.callCount, 2, "the turn under way, and no second turn");
  assert.match(seen[0]?.at(-1) ?? "", /^While you were working, from your background work \(not the user\):\n\[browser task "SHAPE training" \(b-1\): the user handed it back; it is carrying on\]$/);
});

test("a takeover note that cannot be given to a turn under way is kept for the next one", async () => {
  const { tool, running, release } = slow();
  const seen: string[][] = [];
  const { agent, io, replies, conversation, until } = await chat(
    [
      fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("First answer."),
      (context) => {
        seen.push(userTexts(context));
        return fauxAssistantMessage("Second answer.");
      },
    ],
    {
      tools: [tool],
      opened: (session: AgentSession) => {
        session.steer = () => Promise.reject(new Error("the session is closed"));
      },
    },
  );
  agent.prompt(message("check today"), io);
  await running;
  agent.prompt({ kind: "aside", text: '[browser task "SHAPE training" (b-1): the user took control]' }, io);
  release();
  await until(1);
  conversation.push("[08:01] User: how is it going?");
  agent.prompt(message("how is it going?"), io);
  await until(2);
  assert.deepEqual(replies(), ["First answer.", "Second answer."]);
  assert.match(seen[0]?.[0] ?? "", /Since your last turn:\n\[browser task "SHAPE training" \(b-1\): the user took control\]/, "the next turn reads it");
});

const png = { id: "f1", name: "a.png", type: "image/png", size: 3, path: "user/a.png" };
/** A workspace whose pictures take a moment to load, so a message with one is slower to reach the model than one without. */
const slowFiles: Workspace = {
  ...noWorkspace,
  read: async (id) => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return id === png.id ? { attachment: png, data: new Uint8Array([1, 2, 3]) } : null;
  },
};

/** The user sends a picture with a few words, as the server would record it. */
const interjectPicture = (conversation: string[], agent: { prompt(turn: Turn, io: AgentIO): void }, io: AgentIO, text: string) => {
  conversation.push(`[08:01] User: ${text}`);
  agent.prompt({ kind: "message", text, attachments: [png], quote: null }, io);
};

const error = (message: string) => fauxAssistantMessage("", { stopReason: "error", errorMessage: message });

/** A message with a picture comes while the model works on its first step, which then fails before the message is with it. */
async function failedBeforeRead() {
  const sender: { send?: () => void } = {};
  const seen: string[][] = [];
  const made = await chat(
    [
      () => {
        sender.send?.();
        return error("400 invalid request");
      },
      (context) => {
        seen.push(userTexts(context));
        return fauxAssistantMessage("Here is tomorrow.");
      },
    ],
    { files: slowFiles },
  );
  sender.send = () => interjectPicture(made.conversation, made.agent, made.io, "also check tomorrow");
  made.agent.prompt(message("check today"), made.io);
  await made.until(1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  return { ...made, seen };
}

test("a turn that fails with the user's message unread shows its card and starts no turn of its own: Retry answers both, once", async () => {
  const { agent, io, faux, replies, failures, until } = await failedBeforeRead();
  assert.deepEqual(failures(), ["message"]);
  assert.deepEqual(replies(), []);
  assert.equal(faux.state.callCount, 1);
  // Retry sends the user's latest message again
  agent.prompt({ kind: "message", text: "also check tomorrow", attachments: [png], quote: null }, io);
  await until(2);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(replies(), ["Here is tomorrow."]);
  assert.equal(faux.state.callCount, 2);
});

test("nothing is lost if the user does not press Retry but writes again: the next turn takes the message too", async () => {
  const { agent, io, faux, conversation, replies, until } = await failedBeforeRead();
  interject(conversation, agent, io, "never mind, are you there?");
  await until(2);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(replies(), ["Here is tomorrow."]);
  assert.equal(faux.state.callCount, 2);
});

test("a retried note turn takes the user's unread message too", async () => {
  const { agent, io, seen, until } = await failedBeforeRead();
  agent.prompt({ kind: "note", text: "[task t-1 completed] done" }, io);
  await until(2);
  assert.equal(seen.length, 1);
  assert.match(seen[0]?.[0] ?? "", /the user has also written since[\s\S]*The user's newest message:\nalso check tomorrow/, "it took the message in, and was told to answer it, last");
});

test("a note turn that read the user's message mid-turn and then fails is recorded as a turn for the user", async () => {
  const { tool, running, release } = slow();
  const { agent, io, conversation, failures, until } = await chat(
    [fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }), error("400 invalid request")],
    { tools: [tool] },
  );
  agent.prompt({ kind: "note", text: "[task t-1 completed] done" }, io);
  await running;
  interject(conversation, agent, io, "also check tomorrow");
  release();
  await until(1);
  assert.deepEqual(failures(), ["message"]);
});

test("Stop does not drop a message sent just before it: what the model never read is answered", async () => {
  const { tool, running, release } = slow();
  const { agent, io, faux, conversation, replies, until } = await chat(
    [fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }), fauxAssistantMessage("Here is tomorrow.")],
    { tools: [tool], files: slowFiles },
  );
  agent.prompt(message("check today"), io);
  await running;
  interjectPicture(conversation, agent, io, "also check tomorrow");
  agent.interrupt(io);
  release();
  // the stopped turn says nothing more, not even that it ended: the one for the message is the first to end
  await until(1);
  assert.deepEqual(replies(), ["Here is tomorrow."]);
  assert.equal(faux.state.callCount, 2);
});

test("Stop still answers what the user said last: a message the model had read but not answered too", async () => {
  const { tool, running, release } = slow();
  const sender: { stop?: () => void } = {};
  const { agent, io, faux, conversation, replies, until } = await chat(
    [
      fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
      () => {
        // the model has the message and the user presses Stop before it answers
        sender.stop?.();
        return fauxAssistantMessage("Never shown");
      },
      fauxAssistantMessage("Here is tomorrow."),
    ],
    { tools: [tool] },
  );
  sender.stop = () => agent.interrupt(io);
  agent.prompt(message("check today"), io);
  await running;
  interject(conversation, agent, io, "also check tomorrow");
  release();
  await until(1);
  assert.deepEqual(replies(), ["Here is tomorrow."]);
  assert.equal(faux.state.callCount, 3);
});

test("Stop on a turn nobody added to answers nothing more", async () => {
  const { tool, running, release } = slow();
  const { agent, io, faux, replies } = await chat([fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }), fauxAssistantMessage("Never shown")], { tools: [tool] });
  agent.prompt(message("check today"), io);
  await running;
  agent.interrupt(io);
  release();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(replies(), []);
  assert.equal(faux.state.callCount, 1, "no turn is started for what it was asked");
});

test("a file sent on its own answers the user: silence is then allowed", async () => {
  const { tool, running, release } = slow();
  const files: Workspace = { ...noWorkspace, share: async () => png };
  const { agent, io, faux, conversation, replies, until } = await chat(
    [
      fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("send_file", { status: "Sending", path: "a.png" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("no_reply", {}), { stopReason: "toolUse" }),
    ],
    { tools: [tool], files },
  );
  agent.prompt({ kind: "note", text: "[task t-1 completed] done" }, io);
  await running;
  interject(conversation, agent, io, "send me the picture");
  release();
  await until(1);
  assert.deepEqual(replies(), [""], "the file, with no words");
  assert.equal(faux.state.callCount, 3);
});

test("messages sent while a turn sets up are answered by it, once: not again by turns queued for them", async () => {
  const { agent, io, faux, conversation, replies, until } = await chat([fauxAssistantMessage("Both answered.")]);
  agent.prompt(message("first"), io);
  conversation.push("[08:01] User: first");
  interject(conversation, agent, io, "second");
  await until(1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(replies(), ["Both answered."]);
  assert.equal(faux.state.callCount, 1);
});

test("a message that comes while the turn is still setting up its session is in the chat the model is given, and not answered again", async () => {
  const seen: string[][] = [];
  const sender: { send?: () => void } = {};
  const { agent, io, faux, conversation, replies, until } = await chat(
    [
      (context) => {
        seen.push(userTexts(context));
        return fauxAssistantMessage("Both answered.");
      },
    ],
    { opened: () => sender.send?.() },
  );
  sender.send = () => interject(conversation, agent, io, "while you set up");
  agent.prompt(message("hello"), io);
  await until(1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(seen[0]?.[0] ?? "", /while you set up/);
  assert.deepEqual(replies(), ["Both answered."]);
  assert.equal(faux.state.callCount, 1);
});

test("a message that comes after the brief is built and before the model starts is given to it as it starts, not answered in a second run", async () => {
  const seen: string[][] = [];
  const sender: { send?: () => void } = {};
  const { agent, io, faux, conversation, replies, until } = await chat(
    [
      (context) => {
        seen.push(userTexts(context));
        return fauxAssistantMessage("Both answered.");
      },
    ],
    {
      opened: (session) => {
        const prompt = session.prompt.bind(session);
        session.prompt = (text, options) => {
          sender.send?.();
          return prompt(text, options);
        };
      },
    },
  );
  sender.send = () => interject(conversation, agent, io, "just after the brief");
  agent.prompt(message("hello"), io);
  await until(1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(replies(), ["Both answered."]);
  assert.equal(faux.state.callCount, 1);
  assert.match(seen[0]?.at(-1) ?? "", /^The user, while you were working:\njust after the brief/);
});

test("a note turn that took in a message the user sent is answered for them: its failure is retried as theirs", async () => {
  const { agent, io, conversation, failures, until } = await chat([error("400 invalid request")]);
  agent.prompt({ kind: "note", text: "[task t-1 completed] done" }, io);
  interject(conversation, agent, io, "how did it go?");
  await until(1);
  assert.deepEqual(failures(), ["message"]);
});

test("no_reply is refused after the user wrote: they are answered", async () => {
  const { tool, running, release } = slow();
  const { agent, io, faux, conversation, replies, until } = await chat(
    [
      fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("no_reply", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("Here is tomorrow."),
    ],
    { tools: [tool] },
  );
  agent.prompt({ kind: "note", text: "[task t-1 completed] done" }, io);
  // the user writes while it works, and the model, having read it, tries to stay silent
  await running;
  interject(conversation, agent, io, "also check tomorrow");
  release();
  await until(1);
  assert.deepEqual(replies(), ["Here is tomorrow."]);
  assert.equal(faux.state.callCount, 3);
});

test("messages sent one after another reach the model in the order sent, though a file makes one slower to load", async () => {
  const { tool, running, release } = slow();
  const seen: string[][] = [];
  const { agent, io, conversation, until } = await chat(
    [
      fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("Reading.", { stopReason: "stop" }),
      (context) => {
        seen.push(userTexts(context));
        return fauxAssistantMessage("Both read.");
      },
    ],
    { tools: [tool], files: slowFiles },
  );
  agent.prompt(message("start"), io);
  await running;
  interjectPicture(conversation, agent, io, "look at this");
  interject(conversation, agent, io, "and then this");
  // both are with the model before the command ends
  await new Promise((resolve) => setTimeout(resolve, 100));
  release();
  await until(1);
  const heard = (seen[0] ?? []).slice(1);
  assert.match(heard[0] ?? "", /look at this/);
  assert.match(heard[1] ?? "", /and then this/);
});

test("say answers the user mid-turn and the turn goes on: what it read is answered, so Stop owes them nothing more", async () => {
  const { tool, running, release } = slow();
  const second = slow();
  const { agent, io, faux, conversation, replies } = await chat(
    [
      fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("say", { text: "Yes, installing it now." }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("Never shown"),
    ],
    { tools: [tool, defineTool({ ...second.tool, name: "hold" })] },
  );
  agent.prompt(message("render the slides"), io);
  await running;
  interject(conversation, agent, io, "install mise first");
  release();
  await second.running;
  assert.deepEqual(replies(), ["Yes, installing it now."], "said at once, while the turn goes on");
  agent.interrupt(io);
  second.release();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(replies(), ["Yes, installing it now."], "no turn of its own for a message already answered");
  assert.equal(faux.state.callCount, 3);
});
