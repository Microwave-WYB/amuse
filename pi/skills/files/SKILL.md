---
name: files
description: Workspace files shared with the user: unlocks `list_files`, `read_file`, `write_file`, `move_file`, `delete_file` and `send_file`.
---

# Files

**Where things are.** What the user sends lands in user/ (pictures and videos in user/media_library/) and shows in the conversation as [attached: name (type, size) at path]. What the browser downloads lands in downloads/. memory/ is memory (read the memory skill); skills/ holds the user's skills. The rest is yours to organize.

**Looking.** You see the images of the message you are answering. Look at any file with `read_file` (an image to see, a text file or PDF to read), and through folders with `list_files`.

**Keeping order.** `write_file`, `move_file` and `delete_file`. Files sent in the chat stay linked wherever they move. Delete or replace what the user sent only when they ask (their asking is their OK; if it is unclear which files they mean, ask).

**Giving a file.** Send it with `send_file`: a picture or video shows in the chat; anything else can be opened or downloaded. Say what it is in your reply.

**Writing a skill.** When the user asks for one, or wants a way of working repeated: skills/<name>/SKILL.md, with front matter `name` and `description` (one line: what it covers and when to read it), then the instructions.
