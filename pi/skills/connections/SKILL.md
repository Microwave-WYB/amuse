---
name: connections
description: The user's connected apps (mail, calendar, sheets, Slack, GitHub, …): unlocks `request_connection`, `app_tools` and `app_call`.
---

# The user's connections

**Find and use.** For a connection, find the action with `app_tools` (the service's id, e.g. gmail, googlecalendar, and a few words), then run it with `app_call`. Give `summary` (what it does, as the user would say it, with the specifics) and `reason` (why, tied to what they asked): they show on the approval card when one is needed.

**What runs at once and what is asked.** The user's rules decide, per connection and per kind of action (read, change, delete). Reading usually runs at once. Sending, changing, deleting or paying goes to the user on a card and runs in the background once approved; you hear how it went. **Deny is a hard no.** An action of a kind the user said no to (Deny) is still listed, marked as denied, so you can say why. Calling it is refused at once, with no card: the answer names the rule and where to change it (Settings › Connections › the connection › the kind). Tell the user in one line which rule it is. Do not call it again, and do not work around it: not through another tool, another account, or the service's website in the browser. Do not ask again unless the user brings it up.

**Nothing back is not "nothing there".** If an action was refused, failed or found nothing, say which. Never take a refused read for an empty inbox or calendar.

**Not connected yet.** When a request needs a service that is not connected, show its Connect card with `request_connection` instead of guessing.

**More than one account.** A connection can have several accounts at once (two Gmail addresses, a work and a personal calendar). To add another, show the Connect card again with `request_connection`: the user signs in with the other account there, and the ones already connected stay. Once there are several, say which you act as (`account` in `app_call`), and ask when it is not clear which they mean.

**Connections not set up at all.** Connections go through Composio, with the user's own Composio API key, added on a card in the chat (or in Settings › Connections). Why: each service only lets in software it has approved, and Composio is approved by them, so the user need not set each one up; it is their own Composio account, so their logins stay in it and they can revoke them there. Walk them through it a step at a time, in plain words:
1. Sign in or sign up at dashboard.composio.dev.
2. Open Settings, then Project Settings.
3. Under API Keys, copy the key (it starts with ak_).
4. Ask for the key with `request_secret` and `provider: "composio"`: a card opens the sheet where they paste it (the same as Settings › Connections › Add Composio key); it is tested at once. You hear when it is added.
The key goes only on that card or in Settings, never in the chat. Then show the Connect card for the service: it connects it.

**Keeping an eye on things.** When the user connects mail or a calendar, or wants to keep up with them, offer a schedule (for instance new mail every two hours, telling them only what needs them; the day's calendar each morning). Set it up only if they want it (read the schedules skill).
