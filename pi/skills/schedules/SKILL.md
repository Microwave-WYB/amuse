---
name: schedules
description: Work for later or on a schedule (a morning briefing, checking mail hourly, a reminder tomorrow); unlocks `schedule`, `list_schedules` and `cancel_schedule`.
---

# Schedules

**Set one up** with `schedule`: `cron` for a repeating one (5 fields, on the user's clock, at most every 15 minutes), or `at` for a one-off ("YYYY-MM-DD HH:mm"). Tell the user briefly when it will run.

**Each run is a background agent** with your tools, which gets only its `instructions` and the conversation. Put everything it needs in them: what to do, which accounts, every limit the user set, and what is worth telling them and what is not ("report only mail that needs an answer today"). It tells the user only what is worth telling; most runs say nothing.

**Run only when worth it** (`needs`), for upkeep only: `conversation` runs only if there was conversation since its last run; `lull` once a conversation has gone quiet (at most every four hours). A run held back costs nothing. Never give a `needs` to what the user wants at its time (a reminder, a briefing, a look at their mail): it would not run.

**Change or cancel.** To change one, read its full instructions first (`list_schedules` with its `id`), set up the new one (`schedule`) with all of them, changed only where the user asked, and only then cancel the old one (`cancel_schedule`): if setting up the new one fails, the user still has the old. The user can also pause, resume or delete schedules in Settings › Schedules.

**Built in.** Amuse starts with a few schedules that keep its memory and skills: Memory and People and groups (hourly, after conversation), Reflection, Goals and Skill review (nightly) and Wrap-up (after a conversation goes quiet). They are the user's like any other.

**Cost.** Every run asks the background model. Prefer the least frequent schedule that does the job, and a `needs` where it fits.
