/**
 * Speaking mid-turn and staying silent. What the model writes on its way to a
 * tool is its own thinking aloud and is not shown (agent.ts): only what it writes
 * once done is its reply. So a turn of many steps has a tool to say something
 * now and go on (to answer a message the user sent meanwhile, or say what it
 * is starting): `say`. Some turns have nothing for the user (a note from
 * background work that adds nothing, a connection notice already passed on),
 * and the agent needs a way to say so that is not a message: `no_reply`. A turn
 * that calls it shows no reply, whatever else the model writes in it; an empty
 * reply never reaches the chat either (the core's `blank`).
 */
import { type AgentIO, newId } from "@amuse/core";
import { type ToolDefinition, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** `say`: a message to the user now, as a reply of its own, while the turn goes on. */
export function sayTools(io: () => AgentIO): ToolDefinition[] {
  return [
    defineTool({
      name: "say",
      label: "Say",
      description:
        "Send the user a message now and keep working. Use it when the user writes while you are in the middle of something (answer them first, briefly), or before a step that takes a while (say what you are doing). Your final reply still ends the turn; do not repeat in it what you already said.",
      parameters: Type.Object({ text: Type.String({ description: "The message, as you would write your reply" }) }),
      async execute(_id, { text }) {
        if (!text.trim()) return { content: [{ type: "text", text: "Nothing was sent: the message was empty." }], details: null };
        io().emit({ kind: "upserted", entity: { kind: "reply", id: newId("r"), at: new Date().toISOString(), text: text.trim(), streaming: false, attachments: [], suggestions: [], chosen: null } });
        return { content: [{ type: "text", text: "Sent. Go on with what you were doing." }], details: null };
      },
    }),
  ];
}

/**
 * `suggest_replies`: short answers to tap under the reply the agent is about to write. They are kept until a reply is
 * shown (the next one, `say` or the last) and go with it; `offer` is how the turn holds them.
 */
export function suggestTools(offer: (options: string[]) => void): ToolDefinition[] {
  return [
    defineTool({
      name: "suggest_replies",
      label: "Suggest replies",
      description:
        "Attach 2 to 4 short answers the user can tap to your next message, which you write right after. Use it only when the next step is clearly one of a few choices (go ahead or not, which of two options). Never on every message, never as a menu, and never when you need the user's own words, a name, a number or details. Each is what the user would say, in their language, a few words, no ending punctuation.",
      parameters: Type.Object({ options: Type.Array(Type.String({ description: "One short answer, in the user's words" }), { minItems: 2, maxItems: 4 }) }),
      async execute(_id, { options }) {
        const clean = [...new Set(options.map((o) => o.trim()).filter(Boolean))].slice(0, 4);
        if (clean.length < 2) return { content: [{ type: "text", text: "Not attached: give 2 to 4 different options." }], details: null };
        offer(clean);
        return { content: [{ type: "text", text: "They will be shown under your next message. Now write it." }], details: null };
      },
    }),
  ];
}

/** `unanswered`: the user has written in this turn and has not been answered; `silent` is called when the model chooses to say nothing. */
export function silenceTools(unanswered: () => boolean, silent: () => void): ToolDefinition[] {
  return [
    defineTool({
      name: "no_reply",
      label: "Stay silent",
      description:
        "End this turn without a message to the user: this call is the only way to stay silent. Use it when a note from your background work (a task's end, a scheduled check, a heartbeat, a notice you already passed on) has nothing new for them. Whatever you end the turn with reaches the user, so never write this tool's name, or anything standing in for it, as your reply: that is a message, not silence. Anything you write in this turn is dropped, so do not explain why you are staying silent.",
      parameters: Type.Object({}),
      async execute() {
        // never to a user who wrote: silence is for background notes
        if (unanswered()) return { content: [{ type: "text", text: "The user wrote to you and has not been answered yet: reply to them instead." }], details: null };
        silent();
        // nothing more to do in this turn: the model is not called again for it
        return { content: [{ type: "text", text: "Nothing is shown to the user." }], details: null, terminate: true };
      },
    }),
  ];
}
