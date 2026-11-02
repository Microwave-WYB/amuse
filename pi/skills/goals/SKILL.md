---
name: goals
description: The user's goals (memory/goals/): adding one, the schedules that serve it, noting progress, muting, finishing and reopening; unlocks the file tools for goal files.
---

# Goals

A goal is something the user is working toward over weeks or months: gaining weight, learning a language, a race, a move. It is the user's direction. It is not a task for today (do that) and not a single reminder (schedule it).

**A goal does nothing itself.** The work for it is:
- the schedules that serve it: give `goal` (its id) to `schedule`, e.g. meal reminders under a weight goal;
- its nightly research (the Goals schedule).
Those schedules show on the goal's page; they rest (their runs are skipped) while the goal is done, and go on once it is taken up again.

**The files.** A folder a goal, `memory/goals/<id>/` (the id is the title in lower case with dashes, like `gain-weight`):
- `GOAL.md`: front matter, then the document the user reads on the goal's page:
  ```
  ---
  title: Gain weight
  status: active
  added: 2026-10-21
  ---

  What the user wants and why, in their words; what done looks like; any deadline.

  ## Where it stands
  A few lines, kept current: what is done, what is next, what is in the way.
  ```
  - `status` is `active` or `done`; a done one also has `closed: <day>`, and can be reopened.
  - `muted: true` while the user muted it.
- `log.md`: `# Log`, then one note each day it moved, oldest first, appended at the end: `## YYYY-MM-DD · <Progress|Research|...>` and a few lines under it. Links go in the note they came up in.

The user sees the goals in the sidebar (Goals), each on a page of its own: the document, its schedules, the log. They can add, mute, finish and reopen goals there.

**Adding.** When the user says they want to work toward something (or agrees when you ask whether to keep it as a goal), write its GOAL.md as above, with today's day, and say so in a short line. Do not make a goal of something they mentioned in passing. Offer the schedules that would serve it, and set them up only if they want them.

**Progress.** When the user tells you about a step (did the lesson, ate three meals, sent the application), add a note to the log and update "Where it stands". Mention their goals where it helps, not in every reply.

**Muted.** A muted goal is worked on as ever, but nothing of it reaches the user unasked: its schedules' reports go to its log instead, and you do not bring it up yourself. When they ask about it, answer as usual.

**Done and reopened.** Only when the user says it is reached or no longer wanted: set `status: done` and `closed`, and add a closing note. When they take it up again, set it back to `active` and remove `closed`. Its schedules follow by themselves.

**The nightly run** (the Goals schedule): for each active goal, a note with what moved since the last note (from the conversations) and a short research brief: one or two things worth reading or trying next, building on the log rather than repeating it, with links. Keep it practical and short.
