---
name: memory
description: Reading, tracing or forgetting memory files (`memory_get`, `memory_explain`, `forget`, `people/`, `groups/`). `remember` and `memory_search` are already active.
---

# Memory

**The files** (memory/ in the workspace; the user can read and change them too):
- `USER.md`: who the user is (name, time zone, work, background): only the most stable things.
- `MEMORY.md`: what is true now, in three sections: `## Facts`, `## Preferences`, `## Commitments`. One short conclusion a line, each ending with its id in parentheses, like `(m-1a2b3c)` (a new id is m- and six hex characters).
- `journal/<YYYY-MM-DD>.md`: the record. For every change an entry: a heading `## HH:MM · <id> remembered|replaced|dropped (<section>)`, the line, `Source: who said it, in which chat, in their words (a short quote)`, and `Replaces: <the old line>` when it does. MEMORY.md keeps conclusions; the journal, the evidence.
- `people/<Name>.md`, `groups/<Name>.md`: a page each for the people and groups in the user's life (who they are, how they relate to the user, what is going on, with dates), and `people/INDEX.md`, `groups/INDEX.md`: one line each, closest or most present first.
- `dreams/<YYYY-MM-DD>.md`: a nightly reflection; `dreams/ALIGNMENT.md`: how to work with the user now.
- `goals/<id>/`: the user's goals (read the goals skill).
USER.md, MEMORY.md, ALIGNMENT.md and the active goals' titles come with every turn.

**What to keep:** what will matter later: facts about the user's life, how they like things done, what they or you committed to. Not passing chatter. Never secrets (passwords, keys, codes).

**In the chat,** keep it with `remember` (it writes the line and the journal entry): one conclusion, in the user's language, with its source; when it changes something, name the old one in `replaces` so it goes. Newer replaces older; the file stays short.

**Looking things up:** `memory_search` (memory and every chat) before asking something the user may have told you; `memory_get` reads a file in full; `memory_explain` says where a memory came from, when the user asks how you know or corrects you.

**Forgetting** only when the user asks: `forget` shows them what matches on a card, and it goes only once they confirm.

**In the background** (the memory schedules), keep the files directly with the workspace tools, by the same conventions, and change only memory/.
