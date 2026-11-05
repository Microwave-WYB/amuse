/**
 * Speaking mid-turn. What the model writes on its way to a tool is its own
 * thinking aloud and is not shown (agent.ts): only what it writes once done is
 * its reply. So a turn of many steps has a tool to say something now and go on
 * (to answer a message the user sent meanwhile, or say what it is starting):
 * `say`.
 *
 * Staying silent needs no tool. On a note turn (background work that adds
 * nothing, a connection notice already passed on) nothing the turn ends with is
 * shown at all — `say` is the only way such a turn reaches the user — so an
 * agent with nothing to say simply ends it. There used to be a `no_reply` tool
 * for this; a model that wrote its name instead of calling it sent the user the
 * word, so the tool is gone and with it the vocabulary to leak (#82).
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

