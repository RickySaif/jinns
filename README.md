# Jinns

One place for all your local apps. Put app folders in here and open **Jinns**: one page lists every app with its address and whether it's running, lets you start and stop it, and has a chat panel where you tell Claude what to change. Claude works inside that app's folder and drives the running app in a real browser with Playwright.

- Every folder in the Jinns folder is an app. Jinns works out how to start it: Vite, Next.js, Astro, npm `dev`/`start`, Laravel, Jekyll, Django, or plain HTML (Jinns serves it).
- Each app gets a fixed port, starting at 4800. If an app picks its own port anyway, Jinns finds it.
- Each app also gets a fixed address: `http://<app>.jinns/`, and Jinns itself is `http://home.jinns/`.
  Without that setup, the same addresses work as `http://<app>.localhost:4747/`.

## Get started

### macOS

1. Clone the repo, then double-click **`setup.command`**.
2. When setup finishes, double-click **`jinns.command`** to open Jinns.

Setup checks and offers to install each of these:

| | Why | Needed? |
|---|---|---|
| Node.js 20+ | Runs Jinns | Yes |
| [Claude Code](https://code.claude.com/docs/en/setup) | The Claude tab. Sign in once by running `claude`. | For the Claude tab |
| Google Chrome | The browser Claude drives through Playwright | For the Claude tab |
| [Laravel Herd](https://herd.laravel.com) (free) | Serves `<app>.jinns` on port 80 | For `.jinns` addresses |

Setup asks for your Mac password once, so macOS sends `.jinns` names to Herd. It also switches Herd from `.test` to `.jinns`. Undo that with `herd tld test`.

### Windows 10 / 11

1. Clone the repo, then double-click **`setup.cmd`**.
2. When setup finishes, double-click **`jinns.cmd`** to open Jinns.

Setup checks and offers to install, using winget:

| | Why | Needed? |
|---|---|---|
| Node.js 20+ | Runs Jinns | Yes |
| [Claude Code](https://code.claude.com/docs/en/setup) | The Claude tab. Sign in once by running `claude`. | For the Claude tab |
| Git for Windows | Lets Claude use Bash. Without it, Claude uses PowerShell. | Recommended |
| Google Chrome | The browser Claude drives through Playwright | For the Claude tab |

There's no Herd on Windows. Jinns serves `<app>.jinns` on port 80 itself, which Windows allows without admin. Setup adds the names to the Windows hosts file, and Windows asks for admin once to allow that. The hosts file can't hold a wildcard, so each **new** app folder needs its own line. When that happens, Jinns shows an **Add .jinns names** button that does it with one admin prompt.

If another program already uses port 80 (often IIS), Jinns tells you, and apps keep working at `<app>.localhost:4747`.

### Linux

Run `node _jinns/server.mjs --open` and use `http://<app>.localhost:4747/`. `.jinns` addresses aren't set up on Linux.

## Using Jinns

- **Add an app:** put its folder in the Jinns folder and press **Rescan**. Folders starting with `_` or `.` are ignored.
- **The list:** each app shows a status dot (green running, blue running outside Jinns, amber starting, red crashed), its addresses, and Start / Stop / Restart. ↗ opens the app in a new tab. On first start, Jinns runs `npm install` if `node_modules` is missing.
- **⚙ Settings:** override the start command (use `{PORT}` for the port), change the port, open the folder.
- **Claude tab:** click an app, then type an instruction. Claude works in that app's folder, knows its live address, and can click through it with Playwright. Each app keeps its own conversation (it survives a Jinns restart) until **New chat**.
  - *Attachments:* drop files onto the panel, paste a screenshot, or press **Attach**. Up to 50 MB each. Claude reads every attached file. They're stored in `_jinns/.runtime/uploads/` and removed by **New chat**.
  - *Edit files + browser* (default): edits files, uses the browser, runs `npm run …`. Anything else is blocked and reported.
  - *Look only:* reads and browses, changes nothing.
  - *Full auto:* no limits.
- **Logs tab:** live output of the app.
- **Apps started elsewhere** (in a terminal) show up as "running outside Jinns". This works on macOS and Linux only.

Jinns brings its own Playwright setup (`_jinns/.runtime/mcp.json`, written when Jinns starts), so a fresh clone needs nothing extra in your Claude settings.

## Good to know

- Your apps still need their own tools: Python for Python apps, Ruby/Bundler for Jekyll, PHP/Composer for Laravel (Herd includes these on macOS).
- A start command you set in ⚙ is run by your shell: zsh on macOS, cmd.exe on Windows. Commands like `NODE_OPTIONS=x npm run dev` only work on macOS. On Windows use `set NODE_OPTIONS=x&& npm run dev`.
- In Chrome, type `home.jinns/` with the trailing slash the first time, or Chrome searches for it instead.
- Settings (all in `_jinns/config.mjs`): `JINNS_PORT` (4747), `JINNS_PORT_BASE` (4800), `JINNS_TLD` (jinns), `JINNS_HOME` (home), `JINNS_ROOT` (the apps folder), `JINNS_DATA` (where Jinns saves its state, default `_jinns/`), `CLAUDE_BIN`, `HERD_BIN`.
- Jinns' per-machine state lives in `_jinns/jinns.json` and `_jinns/.runtime/`. Both are git-ignored.
- Tests for the cross-platform process and port parsing: `node --test _jinns/test.mjs`.
- How the code is split, and the plan for a desktop app: [ARCHITECTURE.md](ARCHITECTURE.md).

## Undo the .jinns setup

- **macOS:** run `herd tld test` and `sudo rm /etc/resolver/jinns`, remove the `address=/.jinns/…` line from Herd's `dnsmasq.conf`, and run `herd unproxy <name>` for each Jinns proxy (`herd proxies` lists them).
- **Windows:** from an admin PowerShell, run `_jinns\scripts\hosts.ps1 -Remove`.
