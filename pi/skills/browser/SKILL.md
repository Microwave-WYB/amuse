---
name: browser
description: Doing something on a website (log in, fill a form, click through, buy, book) with `browse`; unlocks `read_browser`, `save_screenshot`, `message_run`, `answer_question` and `stop_run`.
---

# Working in a browser

**Look things up without one.** To find or read something, use `web_search` and `web_read`: quick, no browser. A browser is for what has to be done on a site: logging in, filling a form, clicking through, a page that only works in a real browser.

**Start a browser task** with `browse` and tell the user, in a sentence, that it is running: it goes on in the background, and they can watch it or take over at any time.

**Reuse an open browser.** A browser stays open between jobs, with its own agent that remembers what happened in it (where it is, what it has logged in to). For more on the same site, or in a browser the user opened themselves ("Your browser"), give the job to that open, idle browser with `browser` rather than opening another.

**Brief it fully.** The browser agent sees nothing but what you give it: put the user's whole ask in `instructions`, with every limit they set (price, dates, which account, what not to do). Say what to report back.

**Files.** Give in `files` only the workspace files it must upload; the user is asked before each upload (or the rules say no). What it downloads lands in downloads/; send what the user wants with `send_file`.

**The user's rules.** Their permissions (Settings › Permissions) are by kind of action, with exceptions per site: visiting a site (also `web_read`), submitting forms and steps with consequences (buying, sending, submitting, deleting), keeping downloads, uploading files. By default visits and consequential steps are asked about on a card, downloads are kept, uploads are asked about. "Always for this site" on a card makes that site's rule for that action; a site can also be set to never be visited.

**Deny is a hard no.** Where a rule says no, nothing is asked: the step is refused and the answer names the rule and where the user can change it. Tell the user in one line which rule it is and where to change it. Do not work around it (another tool, another route to the same site or thing, a different site for the same purpose without saying so), and do not ask again unless the user brings it up. A download the rules refuse is not kept, and you are told.

**When it needs the user** (a login, a captcha, a code), it says so and waits. Tell the user what it needs and that they can take over. If you can supply it yourself (a code from their mail, an answer they gave), send it with `message_run`: it goes on with that. Give it the whole task, past the login: not "go to the login page" and then a second task, since a browser that has finished waits for nothing. Never type the user's password for them, and never ask for it in the chat: they enter it themselves, by taking over. If they take over a browser whose task was over and hand it back, you hear of it: go on in that browser if there is more to do.

**While it works**, it reports when it ends; between, you look in on it (heartbeats). Never say it is done until you hear it was.
