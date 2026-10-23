# Amuse

[![CI](https://github.com/Microwave-WYB/amuse/actions/workflows/ci.yml/badge.svg)](https://github.com/Microwave-WYB/amuse/actions/workflows/ci.yml)

An open-source Muse: a personal assistant you chat with, that browses the web in a real Chrome
you can watch and take over (from a phone, too), and works with your services. One instance per
person, run with Docker Compose.

<p>
  <img src="docs/screenshots/chat-phone.png" width="260" alt="Amuse asks before visiting a site">
  <img src="docs/screenshots/browser-phone.png" width="260" alt="The browser Amuse works in, live on a phone">
</p>
<img src="docs/screenshots/browser-desktop.png" width="720" alt="Amuse working in the browser beside the chat, on a desktop">

## Start

```sh
git clone git@github.com:Microwave-WYB/amuse.git && cd amuse
docker compose up -d --build  # the first build takes a while: the browser images include Chromium
```

Open `http://localhost:8080`, set a password and a 6-digit PIN, and add an API key for a model provider in
Settings › Models (any provider [Pi](https://github.com/earendil-works/pi) supports). From there,
Amuse walks you through the rest, such as connecting your mail and calendar.

Run amuse where only you can reach it (your machine, a network or VPN you trust), and set the
password right away: the first visit sets it.

The PIN authorizes sensitive actions (loosening a permission, "Always allow" on a card, a new model, voice or
Composio key or speech server, approving a device, changing the password or the PIN). The server checks it for each;
an unlock lasts 5 minutes after the last such action (1, 15 or 30 in Settings › Security), 30 minutes at most, and
ends when the app goes to the background. Five wrong tries lock it for 15 minutes, then twice as long each time.

Signing in on another device takes the password, then approval on a device already signed in: a card there shows the
new one, and approving takes the PIN. A Chrome policy blocks Amuse's own address in its own browsers, as one extra
layer: they do not send the `X-Amuse-Agent` mark yet (their pages run in Playwright contexts, where an extension
cannot add it), so a browser that reaches Amuse anyway meets only the password and the device approval.

## Other devices

amuse listens on `127.0.0.1:8080` only. To reach it from your phone or another computer, keep it there
and put in front of it whatever you already use: a reverse proxy (Caddy, nginx), a tunnel (frp,
Cloudflare Tunnel), or [Tailscale](https://tailscale.com)'s `tailscale serve --bg 8080`. Then set
`AMUSE_PUBLIC_URL` in `.env` to the address people use (`https://amuse.example.com`). Pasting from the
phone's clipboard into the browser you take over, and the mic, need https.

Or publish it on another address instead: `AMUSE_PUBLISH_HOST=192.168.0.10` (a LAN address; `0.0.0.0` for
all of them) and `AMUSE_PUBLIC_URL=http://192.168.0.10:8080` in `.env`. That is plain http, so only on a
network you trust.

Either way is fine for the sandbox (below): it cannot reach the host, your network or your other devices
however Amuse is published.

Then `docker compose up -d`.

## Voice

The mic turns what you say into text with OpenAI, Groq or Fireworks (your key), or a speech
server you run yourself (any OpenAI-style `/v1/audio/transcriptions`, e.g. faster-whisper-server):
Settings › Models › Voice. Run it in Docker beside Amuse and give its service name as the address;
on the host outside Docker it is `host.docker.internal`, which a host firewall (ufw) may block for
containers. The mic needs https (see above).

## Sandbox

Amuse has a computer of its own: a Debian 13 container where it runs commands, installs software
(`sudo apt install …`, pip, npm) and runs programs and servers. It works there as a normal user
with passwordless `sudo`, on files it shares with you: your workspace (the files Amuse keeps) is
mounted in it. Commands are not approved one by one, because the container is the boundary; what
leaves it, and deleting or overwriting the files you sent, still needs your word.

- It reaches the public internet, and nothing of yours. Connections from it to the host, your LAN,
  Tailscale and other VPN peers, link-local addresses, the ranges proxy tools on the host (Clash, sing-box,
  Surge) hand out as fake addresses (`198.18.0.0/15`) and any other private address are refused at once,
  open ones as well as new; so is the sandbox's own network (the Amuse server is on it, and may open
  connections to any port the sandbox listens on: replies to those are all that passes there). Whatever
  else runs on your host, and however you publish Amuse, the sandbox cannot get to it. IPv6 is refused
  altogether (`AMUSE_SANDBOX_IPV6=1` allows it, if the network has IPv6: untested; then the global IPv6
  addresses of the host and your LAN look public to the rules and are not refused).
  One thing the rules cannot know: if the host has a public IP address of its own, services listening on it
  count as the public internet. Bind them to loopback or firewall them.
- How that is kept. `sandbox-net`, a small container that owns the sandbox's network, puts the rules in,
  and the sandbox shares that network without the capability to change them (not even as root). The sandbox
  never runs before them as shipped: its daemon, the only thing that runs there (nothing starts by itself), starts
  and listens on nothing until `sandbox-net` has put the rules in, checked them and written a ready mark on
  a volume the sandbox can only read; it ends if the mark goes. Until the rules are in, everything but
  loopback is refused. `docker compose up` also waits for `sandbox-net`'s health check, but that gates the
  command only; Docker's own restarts (a reboot, a restart of the Docker service, a crash) ignore it, and
  the mark is what covers them. If the rules cannot be put in, `sandbox-net` stays up, unhealthy, and says
  why in its log (`docker compose logs sandbox-net`), and the sandbox waits. Root in the sandbox can change
  its own programs, and those changes last until it is recreated: if you think it was tampered with,
  `docker compose up -d --force-recreate sandbox-net sandbox`.
- DNS goes through Docker's resolver, which asks the host's own DNS server (often your router): the sandbox
  can look up the names of machines on your LAN, and nothing more; it cannot reach them.
- It holds no keys or password, has no Docker socket, is not privileged, has only the capabilities sudo and
  apt need, and sees only the workspace of Amuse's data. The Amuse server also turns away every request from
  the sandbox's network, and the browsers cannot reach it.
- Terminals: [herdr](https://github.com/herdrdev/herdr) runs there, and its terminals are shared by
  Amuse and you. Amuse runs what goes on (servers, logins that ask for a code, coding agents such as
  Claude Code) in them; open the viewer on the right and pick Terminal to see herdr's own interface,
  pick a workspace or pane with the mouse or its keys (`ctrl+b`), and type there too. On a phone a row
  of keys (Esc, Ctrl, Alt, Tab, arrows) sits under it. Closing the view, or herdr's detach
  (`ctrl+b q`), only leaves: what runs there goes on.
- Web apps: Amuse's browsers reach the sandbox as `http://sandbox:<port>`, so a web app Amuse runs there
  opens in its browser, which you watch and take over in the viewer. The browsers share the sandbox's
  network for that; the sandbox cannot connect back to them (its rules let out only replies there), and
  its control daemon takes nothing a browser sends. Your own phone or computer cannot open these
  addresses yet (#13).
- Two folders of the workspace are read-only there: `memory/`, which Amuse reads as its own context, and
  `user/`, what you sent. Amuse edits its memory with its own tools, not from a shell; to work on a file
  you sent, it makes a copy elsewhere. `skills/` is writable and is also `~/.agents/skills`, so
  `npx skills add -g …` installs straight into Amuse's skills; Amuse tells you about each new or changed
  one. The three folders always exist and cannot be removed or renamed, only emptied; a file
  moved into one is copied (the sandbox may still hold the original open), not renamed.
- Limits: 2 CPUs, 4 GB of memory and 1024 processes; change them in `.env` with
  `AMUSE_SANDBOX_CPUS`, `AMUSE_SANDBOX_MEMORY` and `AMUSE_SANDBOX_PIDS`. There is no disk limit
  (Docker has none on most setups): what the sandbox writes fills the disk Docker lives on, its home
  folder and installed software in their own volume and the container, and what it writes into the
  workspace in the data volume (`amuse-data`), beside your chats. Watch `docker system df`.
- Its home folder (what it installs for itself, its settings and caches) is a volume of its own, and
  stays across restarts. Packages installed with `apt` and changes to `/etc` live in the container
  instead: they stay across restarts, and go when the container is recreated, which an update can do.
- Reset: Settings › Sandbox › Reset stops everything running there and wipes its home folder. It does
  not undo system-wide installs or changes in `/etc`; those stay until the container is recreated:
  `docker compose up -d --force-recreate sandbox` (the server has no Docker socket to do it for you).
  Your workspace is kept either way.
- The sandbox network has a fixed address range, `10.231.250.0/24`, which the server turns away from its
  first request (`sandbox-net` refuses it too). If it clashes with a network you have, set
  `AMUSE_SANDBOX_SUBNET` in `.env` to another free range and run `docker compose up -d`; compose gives the
  server and `sandbox-net` the same value.
- Turn it off: `AMUSE_SANDBOX_URL=` (empty) in `.env`, then `docker compose up -d`. Amuse then has no
  sandbox tools, and the server still turns away the sandbox's network. The containers stay, idle; to
  drop them, remove the `sandbox`, `sandbox-net` and `sandbox-init` services from `compose.yaml`.
- `sandbox-net` and `sandbox` go together. `docker compose up -d` (also after an update) keeps them in step,
  and `docker compose restart sandbox-net` restarts both. To recreate them: `docker compose up -d
  --force-recreate sandbox-net sandbox`. If `sandbox-net` alone is restarted behind compose's back (a crash,
  `docker restart`), the sandbox has no network until it is restarted; it ends itself within a few seconds
  (the daemon watches for it), Docker brings it back into the new network, and it never has an open one in
  between.

## The Vault

Settings › Vault keeps the long-term secrets Amuse uses for you: API keys, tokens, passwords, key files,
and the keys of its own models, speech and connections. An entry has plain fields (an account id, a username:
Amuse and you can see them), secret fields (never shown back; you replace them) and a note. Where a secret is
used is separate from what it is: a variable or file in the sandbox, or one of Amuse's own services (which
neither Amuse nor the sandbox ever sees).

- The Vault is in the database (`amuse.db`). Secret fields are encrypted (AES-256-GCM) with a key in a file of its
  own, `store.key`, in a volume of its own (`vault-key`, at `/secrets/amuse-store`), apart from `/data` and from the
  browsers' `secrets` volume: a copy of `/data` alone opens nothing, and `docker volume rm` of `secrets` cannot destroy it. A compromised server does give the secrets, so this is not protection against that.
- **Back the key up** (`docker compose cp amuse:/secrets/amuse-store/store.key .`, and keep it safe). Without it
  nothing in the Vault can be opened, and Amuse refuses to start (its address says so) rather than make a new key
  over secrets sealed with the old one. If the key is lost for good, `docker compose exec amuse amuse-admin
  reset-vault --yes` forgets everything in the Vault so a new key can be made; you add your keys and secrets again.
- A temporary code (a login or verification code a program waits for) is not kept: you type it on a card and it
  goes straight into the terminal that waits for it.
- When you upgrade from an earlier version, `keys.json`, `models.json` and `sandbox-secrets.json` move into the
  database once, on the first start, and `keys.json` and `sandbox-secrets.json` (which held secrets in the open) are
  deleted once the move is checked: no plaintext copy is left anywhere. The database keeps a copy of each, sealed with
  the Vault's key, so you can go back: `amuse-admin restore-secret-files` writes them out again, and
  `amuse-admin forget-secret-files --yes` deletes those copies once you are sure.

## Good to know

- Your conversation, the password, your secrets and keys (sealed; their key is in the `vault-key` volume), saved browser data and the sandbox's home folder live in Docker volumes;
  they survive restarts and updates. `docker compose down -v` deletes them.
- Update: `git pull && docker compose up -d --build`. Before an update that changes the stored data, Amuse copies its database to `backups/` in the data volume;
  `docker compose exec amuse amuse-admin migrate --dry-run` shows beforehand what would change.
- Change the password or the PIN, lock a device, or remove one: Settings › Security. Changing the password signs every
  other device out; they stay trusted.
- Forgot the password: `docker compose exec amuse amuse-admin reset-password`,
  then set a new one on the next visit. Your chats and keys stay.
- Forgot the PIN: `docker compose exec amuse amuse-admin reset-pin`. Every device is signed out; sign in, and Amuse asks
  for a new one.
- Lost every device you signed in on: `docker compose exec amuse amuse-admin reset-devices`. The next device to sign in
  with the password is trusted.
- Use another port: `AMUSE_PUBLISH_PORT=9000` in `.env` (and `AMUSE_PUBLIC_URL=http://localhost:9000`).

Development: [docs/development.md](docs/development.md). CI runs `mise run check` — the type checks, every
package's tests and the Dockerfile check — on every pull request and on `main`, and builds both images;
running it locally is the same thing.

## License

[MIT](LICENSE). Amuse is an independent project, not affiliated with Meta or its Muse.
