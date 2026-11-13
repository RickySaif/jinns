# Jinns architecture

Jinns runs today as a local web app you start from the repo. The plan is to ship it later as a desktop app (and, further out, a marketplace that installs software for people who never open a terminal). This document describes how the code is split so that move is a new wrapper, not a rewrite.

## The layers

```
  Launchers (how Jinns is started)          Today: server.mjs, run by jinns.command / jinns.cmd
  ───────────────────────────────           Later: desktop/main.mjs (Electron), same engine
                 │  startHub() / stopAll()
                 ▼
  Engine: hub.mjs                           Finds apps, starts/stops them, finds their ports,
  ───────────────────────────────           routes <app>.localhost and <app>.<tld>, runs Claude,
     │          │           │                stores chats and uploads, serves the page and API
     ▼          ▼           ▼
  platform.mjs  Domains     Claude          OS adapters: process tree + ports (ps/lsof/PowerShell),
  (processes,   (Herd,      (claude CLI     address setup, the AI agent. Each is replaceable.
   ports)       hosts file)  + Playwright)
                 │
  config.mjs ────┘                          Every setting and path, from env vars with repo defaults
                 ▲
  public/index.html                         The page. Talks to the engine only over HTTP + SSE.
```

| File | Role | Knows about the terminal? |
|---|---|---|
| `_jinns/config.mjs` | Every setting and path in one place | No |
| `_jinns/hub.mjs` | The engine. Exports `startHub()`, `stopAll()`, `openPath()`, `homeUrl()` | No |
| `_jinns/server.mjs` | Terminal launcher: prints addresses, opens the browser, exits on Ctrl+C | Yes, and only this file |
| `_jinns/platform.mjs` | Pure parsing of process and port listings, per OS. Unit-tested in `test.mjs` | No |
| `_jinns/public/index.html` | The whole UI, one file, no build step | No |
| `_jinns/scripts/` | First-time setup (macOS, Windows) and the Windows hosts-file helper | Yes. Replaced by an in-app setup screen later |

## Rules that keep the app move cheap

1. **The page only talks HTTP.** `index.html` uses `fetch`, `EventSource` and `XMLHttpRequest` against `/api/*`, nothing else. It never assumes Node, the file system or a browser extension. The same page works in a browser tab today and in an Electron window later.
2. **Code and data are separate.** Everything Jinns writes goes under `DATA_DIR` (`jinns.json`, `.runtime/` with chats, uploads and the generated Playwright config). In the repo, `DATA_DIR` defaults to `_jinns/`, so nothing moved. A packaged app's code folder is read-only, so the app sets `JINNS_DATA` to its user-data folder.
3. **Only launchers may touch the terminal.** No `process.argv`, `process.exit` or interactive prompts in `hub.mjs`. Anything that needs the person's input (like the `.jinns` password step) appears as a button in the page, and the OS shows its own prompt.
4. **Every external program comes from config.** `claude` and `herd` are read from `CLAUDE_BIN` and `HERD_BIN`. A packaged app can point them at copies it ships. When Node/npm get bundled, they join this list and are put on the `PATH` that apps start with (`childEnv()` in `hub.mjs`).
5. **Address setup is a strategy, not a requirement.** Domains are handled by one of several modes: Herd on macOS, the hosts file plus Jinns on port 80 on Windows, and plain `<app>.localhost:<port>` everywhere as the fallback. New modes slot in next to `syncHerd()` and `syncHosts()`.

## Moving to a desktop app

The steps, smallest first. Each one is useful on its own.

1. **Jinns serves port 80 itself** (no Herd needed). Checked on macOS 14: an unprivileged process may listen on port 80 on all addresses (`0.0.0.0` / `::`), not on `127.0.0.1` alone. So Jinns must listen on all addresses and refuse connections that don't come from the machine itself. macOS resolves `*.localhost` to the machine with no setup, so this gives `http://<app>.localhost/` with no install and no password. If Herd is already on port 80, keep using Herd.
2. **Electron wrapper:** `desktop/main.mjs` sets `JINNS_DATA` (and, later, the bundled binaries), then `await import('../_jinns/hub.mjs')`, calls `startHub()`, and opens a window on `hub.url`. Tray icon. `stopAll()` runs on quit. Unsigned builds: the person clicks *Open Anyway* (macOS) or *More info → Run anyway* (Windows) once. Ship an illustrated guide for that.
3. **In-app first-run screen** replaces `scripts/setup-*.sh|ps1`: checks Claude Code and signs in.
4. **Own `.jinns` names, without Herd:** a small DNS responder in the engine, plus one `/etc/resolver/jinns` file written behind the system password prompt.
5. **Later:** local HTTPS certificates, auto-update.

Electron is the right shell because it includes Node, so `hub.mjs` runs unchanged. Tauri would need Node shipped separately anyway.

## Where the marketplace fits later

None of this exists yet. These are the slots it would use.

- **App manifest** (`jinn.json` in an app's folder): name, how to start it, what it needs (Node, PHP, a device), price and licence. `detect()` in `hub.mjs` keeps working for folders without one.
- **Catalog:** start as a public Git repo of manifests that Jinns reads, with a *Get* button that downloads and starts an app. No backend needed to test demand.
- **Backend** (accounts, private repos, payments and licences, updates, reviews, high-touch requests): only once the catalog shows demand. The engine would talk to it over HTTPS from a new module next to the domain and Claude adapters. The page would keep talking only to the engine.
- **Trust:** before running third-party code for non-technical people, each catalog app needs review, and Claude's permissions need tightening per app. This is the hardest part and the main reason people would trust a marketplace over a random repo.
