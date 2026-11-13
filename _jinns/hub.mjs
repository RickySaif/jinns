// Jinns hub: the engine. Scans the apps folder, starts/stops each app, finds the port it opens,
// routes <app>.<tld> and <app>.localhost:<hub port> to it, and runs Claude in each folder.
// No terminal-only code lives here (no argv, no console prompts, no process.exit), so the
// terminal launcher (server.mjs) and a future desktop app can both drive it. See ARCHITECTURE.md.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import { spawn, execFile } from 'node:child_process';
import { WIN_SNAPSHOT_PS, parseSnapshot, psToLines, lsofToLines, treeOf, treePorts, slug, cmdQuote } from './platform.mjs';
import {
  IS_WIN, IS_MAC, CODE_DIR as HERE, ROOT, HUB_PORT, PORT_BASE, STATE_FILE, RUNTIME_DIR, MCP_FILE,
  UPLOAD_DIR, CHAT_DIR, UPLOAD_LIMIT, CLAUDE_BIN, HERD_BIN, TLD, HOME_NAME, HOME_HOSTS, HERD_DNSMASQ, LOG_LIMIT,
} from './config.mjs';

// ---------- persisted state: stable ports, custom commands, Claude sessions ----------
let state = loadState();
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { apps: {} }; }
}
function saveState() { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
function conf(name) { return (state.apps[name] ??= {}); }

// ---------- runtime ----------
const runs = new Map();   // name -> { proc?, server?, pid, status, port, ports, wantPort, ... }
const logs = new Map();   // name -> [{ line, level, at }]
const chats = new Map();  // name -> { proc, events: [] }
const clients = new Set(); // SSE responses

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
const appDir = (name) => path.join(ROOT, name);

function sh(cmd, args) {
  return new Promise((resolve) => execFile(cmd, args, { maxBuffer: 8 << 20, windowsHide: true }, (_e, out) => resolve(out || '')));
}

function emit(obj) {
  const msg = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of clients) res.write(msg);
}

function log(name, line, level = 'out') {
  const buf = logs.get(name) || [];
  const entry = { line, level, at: Date.now() };
  buf.push(entry);
  if (buf.length > LOG_LIMIT) buf.splice(0, buf.length - LOG_LIMIT);
  logs.set(name, buf);
  emit({ t: 'log', app: name, ...entry });
}

function emitStatus(name) { emit({ t: 'app', app: appInfo(name) }); }

// ---------- platform layer ----------
function childEnv(extra = {}) {
  const env = { ...process.env, BROWSER: 'none', FORCE_COLOR: '0', NO_COLOR: '1', ...extra };
  // Let `claude` start even when Jinns itself was launched from a Claude session.
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) delete env[k];
  return env;
}

// Run a shell command line the way the user's own terminal would.
function shellSpawn(cmd, opts) {
  if (IS_WIN) return spawn(cmd, { ...opts, shell: true, windowsHide: true });
  const shell = IS_MAC ? '/bin/zsh' : '/bin/bash';
  return spawn(shell, ['-lc', cmd], { ...opts, detached: true });
}

// Spawn a CLI with an argument list. Windows refuses to spawn .cmd/.bat files
// directly (CVE-2024-27980), so those go through cmd.exe with every argument quoted.
function spawnCli(bin, args, opts) {
  if (IS_WIN && /\.(cmd|bat)$/i.test(bin)) {
    return spawn(`${cmdQuote(bin)} ${args.map(cmdQuote).join(' ')}`, { ...opts, shell: true, windowsHide: true });
  }
  return spawn(bin, args, { ...opts, windowsHide: true });
}

const resolvedBins = new Map();
async function resolveBin(name) {
  if (!IS_WIN || /[\\/]/.test(name)) return name;
  if (!resolvedBins.has(name)) {
    const found = (await sh('where.exe', [name])).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    resolvedBins.set(name, found.find((p) => /\.exe$/i.test(p)) || found.find((p) => /\.(cmd|bat)$/i.test(p)) || name);
  }
  return resolvedBins.get(name);
}

function killTree(pid, force = false) {
  if (IS_WIN) return void execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
  try { process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
}

export function openPath(target) {
  if (IS_WIN) spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref();
  else spawn(IS_MAC ? 'open' : 'xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
}

// One look at the machine: who is whose parent, and which process listens on which port.
async function snapshot() {
  if (IS_WIN) {
    const encoded = Buffer.from(WIN_SNAPSHOT_PS, 'utf16le').toString('base64');
    return parseSnapshot(await sh('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]));
  }
  const [ps, lsof] = await Promise.all([
    sh('ps', ['-A', '-o', 'pid=,ppid=']),
    sh('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']),
  ]);
  return parseSnapshot(`${psToLines(ps)}\n${lsofToLines(lsof)}`);
}

// ---------- discovery ----------
function listFolders() {
  return fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !/^[._]/.test(d.name) && d.name !== 'node_modules')
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

// Work out how to start a folder. {PORT} is replaced with the port Jinns picked.
function detect(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  const html = () => fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
  if (has('artisan')) {
    return { kind: 'laravel', cmd: 'php artisan serve --port={PORT}', install: has('vendor') ? null : 'composer install' };
  }
  if (has('package.json')) {
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch {}
    const scripts = pkg.scripts || {};
    const script = ['dev', 'start', 'serve'].find((k) => scripts[k]);
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length;
    const install = deps && !has('node_modules') ? 'npm install' : null;
    if (script) {
      const body = scripts[script];
      let kind = 'node', extra = '';
      if (/\bvite\b/.test(body)) { kind = 'vite'; extra = ' -- --port {PORT} --strictPort'; }
      else if (/\bnext\b/.test(body)) { kind = 'next'; extra = ' -- -p {PORT}'; }
      else if (/\bastro\b/.test(body)) { kind = 'astro'; extra = ' -- --port {PORT}'; }
      else if (/python/.test(body)) kind = 'python';
      return { kind, cmd: `npm run ${script}${extra}`, install };
    }
  }
  if (has('_config.yml') && has('Gemfile')) {
    return { kind: 'jekyll', cmd: 'bundle exec jekyll serve --port {PORT}', install: has('Gemfile.lock') ? null : 'bundle install' };
  }
  if (has('manage.py')) return { kind: 'django', cmd: `${IS_WIN ? 'python' : 'python3'} manage.py runserver {PORT}` };
  const pages = html();
  if (pages.length) return { kind: 'static', cmd: null, entry: pages.includes('index.html') ? '' : pages[0] };
  return { kind: 'unknown', cmd: null };
}

// Apps started outside Jinns (a terminal, another tool) still show up: any
// listening process whose working directory is inside an app folder.
// Windows does not expose another process's working directory, so this is macOS/Linux only.
let external = { at: 0, map: new Map() };
async function scanExternal(force = false) {
  if (IS_WIN) return external.map;
  if (!force && Date.now() - external.at < 2500) return external.map;
  const map = new Map();
  const snap = await snapshot();
  const managed = new Set();
  for (const r of runs.values()) if (r.proc && r.proc.exitCode === null) for (const p of treeOf(r.pid, snap.parent)) managed.add(p);
  const pids = [...snap.listen.keys()].filter((p) => p !== process.pid && !managed.has(p));
  if (pids.length) {
    const cwds = await sh('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')]);
    let cur;
    for (const l of cwds.split('\n')) {
      if (l[0] === 'p') cur = Number(l.slice(1));
      else if (l[0] === 'n' && cur && l.slice(1).startsWith(ROOT + path.sep)) {
        const name = l.slice(ROOT.length + 2).split(path.sep)[0];
        if (name.startsWith('_') || runs.get(name)?.status === 'running') continue;
        const ports = [...snap.listen.get(cur)].sort((a, b) => a - b);
        const prev = map.get(name);
        if (!prev || ports[0] < prev.port) map.set(name, { pid: cur, port: ports[0], ports });
      }
    }
  }
  const changed = [...new Set([...map.keys(), ...external.map.keys()])]
    .filter((n) => map.get(n)?.port !== external.map.get(n)?.port);
  external = { at: Date.now(), map };
  for (const n of changed) if (fs.existsSync(appDir(n))) emitStatus(n);
  return map;
}

function currentPort(name) {
  const r = runs.get(name);
  return (r?.status === 'running' && r.port) || external.map.get(name)?.port || null;
}

function domainOf(s) {
  return domains.ready && domains.names.has(s) ? `http://${s}.${TLD}/` : null;
}

function appInfo(name) {
  const d = detect(appDir(name));
  const c = conf(name);
  const r = runs.get(name);
  const ext = external.map.get(name);
  let status = r?.status || 'stopped', port = r?.port || null, pid = r?.pid || null, ports = r?.ports || [];
  if (ext && !['starting', 'running', 'installing'].includes(status)) {
    status = 'external'; port = ext.port; pid = ext.pid; ports = ext.ports;
  }
  const s = slug(name);
  return {
    name, slug: s, kind: d.kind, path: appDir(name),
    domain: domainOf(s),
    cmd: c.cmd || d.cmd, autoCmd: d.cmd, custom: !!c.cmd,
    install: d.install, status, port, ports, pid, assignedPort: c.port || null,
    exitCode: r?.exitCode ?? null,
    url: port ? `http://localhost:${port}/${d.entry ? encodeURIComponent(d.entry) : ''}` : null,
    hubUrl: `http://${s}.localhost:${HUB_PORT}/`,
    claude: { running: !!chats.get(name)?.proc, hasSession: !!c.sessionId },
  };
}

// ---------- ports ----------
function isListening(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: 'localhost', port, autoSelectFamily: true });
    sock.setTimeout(400);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.once('error', () => resolve(false));
  });
}
function canBind(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, () => srv.close(() => resolve(true)));
  });
}

// Each app keeps the same port across restarts unless something else grabbed it.
async function assignPort(name) {
  const c = conf(name);
  const taken = new Set(Object.entries(state.apps).filter(([n]) => n !== name).map(([, v]) => v.port));
  let p = c.port || PORT_BASE;
  while (taken.has(p) || p === HUB_PORT || (await isListening(p)) || !(await canBind(p))) p++;
  if (c.port !== p) { c.port = p; saveState(); }
  return p;
}

// ---------- processes ----------
function lineSplitter(onLine) {
  let rest = '';
  return (chunk) => {
    const parts = (rest + chunk).split(/\r?\n|\r/);
    rest = parts.pop();
    for (const p of parts) if (p.trim()) onLine(p);
  };
}

function spawnProc(name, cmd, { port, phase }) {
  log(name, `$ ${cmd}`, 'cmd');
  const proc = shellSpawn(cmd, { cwd: appDir(name), env: childEnv(port ? { PORT: String(port) } : {}) });
  const r = { proc, pid: proc.pid, status: phase, port: null, ports: [], wantPort: port, startedAt: Date.now() };
  runs.set(name, r);
  emitStatus(name);
  const onLine = (l) => {
    const line = stripAnsi(l);
    log(name, line);
    const m = line.match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1?\]|0\.0\.0\.0):(\d{2,5})/);
    if (m) r.hintPort = Number(m[1]);
  };
  proc.stdout.on('data', lineSplitter(onLine));
  proc.stderr.on('data', lineSplitter(onLine));
  proc.on('error', (e) => log(name, `[jinns] ${e.message}`, 'err'));
  proc.on('exit', (code, sig) => {
    if (runs.get(name) !== r) return;
    r.status = r.stopping || code === 0 ? 'stopped' : 'crashed';
    r.exitCode = code; r.port = null; r.ports = [];
    log(name, `[jinns] ${phase === 'installing' ? 'install' : 'process'} exited (${sig || code})`, code && !r.stopping ? 'err' : 'sys');
    emitStatus(name);
    r.onExit?.(code);
  });
  if (phase === 'starting') watchPort(name, r);
  return r;
}

// Find the port the app really opened: whatever its process tree listens on.
// If the process list is unavailable, fall back to the port Jinns asked for or the one it printed.
async function watchPort(name, r) {
  const t0 = Date.now();
  while (runs.get(name) === r && r.status === 'starting' && Date.now() - t0 < 180000) {
    await sleep(IS_WIN ? 1500 : 700);
    const snap = await snapshot();
    const ports = treePorts(r.pid, snap);
    if (!ports.length) {
      for (const p of [r.wantPort, r.hintPort]) if (p && (await isListening(p))) ports.push(p);
    }
    if (!ports.length || r.status !== 'starting') continue;
    r.ports = ports;
    r.port = [r.wantPort, r.hintPort].find((p) => ports.includes(p)) || ports[0];
    r.status = 'running';
    log(name, `[jinns] listening on http://localhost:${r.port}${ports.length > 1 ? `  (also ${ports.filter((p) => p !== r.port).join(', ')})` : ''}`, 'sys');
    emitStatus(name);
  }
}

async function startApp(name) {
  const r = runs.get(name);
  if (r && ['starting', 'running', 'installing'].includes(r.status)) return;
  if (external.map.get(name)) throw new Error('Already running outside Jinns. Stop it first.');
  const info = appInfo(name);
  const port = await assignPort(name);
  if (!info.cmd) {
    if (info.kind === 'static') return startStatic(name, port);
    throw new Error('No start command found. Set one in the app settings (⚙).');
  }
  if (info.install && !info.custom) {
    // First run: install dependencies, then start.
    const inst = spawnProc(name, info.install, { phase: 'installing' });
    inst.onExit = (code) => { if (code === 0) startApp(name).catch((e) => log(name, `[jinns] ${e.message}`, 'err')); };
    return;
  }
  spawnProc(name, info.cmd.replaceAll('{PORT}', port), { port, phase: 'starting' });
}

function stopApp(name) {
  const r = runs.get(name);
  if (r?.server) {
    r.server.closeAllConnections?.();
    r.server.close();
    r.status = 'stopped'; r.port = null;
    log(name, '[jinns] static server stopped', 'sys');
    return emitStatus(name);
  }
  if (r?.proc && r.proc.exitCode === null && r.proc.signalCode === null) {
    r.stopping = true;
    killTree(r.pid);
    setTimeout(() => { if (r.proc.exitCode === null && r.proc.signalCode === null) killTree(r.pid, true); }, 4000);
    return;
  }
  const ext = external.map.get(name);
  if (ext) {
    try { process.kill(ext.pid, 'SIGTERM'); } catch {}
    log(name, `[jinns] sent stop to external process ${ext.pid}`, 'sys');
    setTimeout(() => scanExternal(true), 800);
  }
}

async function restartApp(name) {
  const r = runs.get(name);
  if (r?.proc && r.proc.exitCode === null && r.proc.signalCode === null) {
    await new Promise((resolve) => { r.onExit = resolve; stopApp(name); });
  } else stopApp(name);
  await sleep(300);
  await startApp(name);
}

// ---------- built-in static server for plain HTML folders ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.xml': 'application/xml', '.wasm': 'application/wasm',
};

function serveStatic(dir, req, res) {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
  const file = path.join(dir, rel);
  if (file !== dir && !file.startsWith(dir + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    if (st.isDirectory()) {
      if (!rel.endsWith('/')) { res.writeHead(301, { location: rel + '/' }); return res.end(); }
      const index = path.join(file, 'index.html');
      if (fs.existsSync(index)) return sendFile(index, res);
      const items = fs.readdirSync(file).filter((f) => !f.startsWith('.'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><meta charset=utf-8><title>${rel}</title><body style="font:15px system-ui;padding:24px"><h3>${rel}</h3>` +
        items.map((f) => `<div><a href="${encodeURIComponent(f)}">${f.replace(/</g, '&lt;')}</a></div>`).join('') + '</body>');
    }
    sendFile(file, res);
  });
}
function sendFile(file, res) {
  res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

function startStatic(name, port) {
  const dir = appDir(name);
  const server = http.createServer((req, res) => serveStatic(dir, req, res));
  const r = { server, status: 'starting', wantPort: port, port: null, ports: [] };
  runs.set(name, r);
  emitStatus(name);
  server.on('error', (e) => { r.status = 'crashed'; log(name, `[jinns] ${e.message}`, 'err'); emitStatus(name); });
  server.listen(port, '127.0.0.1', () => {
    r.status = 'running'; r.port = port; r.ports = [port];
    log(name, `[jinns] serving static files on http://localhost:${port}`, 'sys');
    emitStatus(name);
  });
}

// ---------- Claude, one conversation per app ----------
// Jinns brings its own Playwright MCP config, so a fresh clone needs no Claude setup beyond signing in.
function writeMcpConfig() {
  const playwright = IS_WIN
    ? { command: 'cmd', args: ['/c', 'npx', '-y', '@playwright/mcp@latest'] }
    : { command: 'npx', args: ['-y', '@playwright/mcp@latest'] };
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(MCP_FILE, JSON.stringify({ mcpServers: { playwright } }, null, 2));
}

// Chat history survives a Jinns restart; Claude's own session is resumed by id.
const chatFile = (name) => path.join(CHAT_DIR, `${slug(name)}.json`);
function chatOf(name) {
  if (!chats.has(name)) {
    let events = [];
    try { events = JSON.parse(fs.readFileSync(chatFile(name), 'utf8')); } catch {}
    chats.set(name, { proc: null, events });
  }
  return chats.get(name);
}
function saveChat(name) {
  try { fs.mkdirSync(CHAT_DIR, { recursive: true }); fs.writeFileSync(chatFile(name), JSON.stringify(chatOf(name).events)); } catch {}
}

// ---------- attachments: files dropped or pasted into the chat ----------
const uploadDir = (name) => path.join(UPLOAD_DIR, slug(name));
function findUpload(name, id) {
  if (!/^[a-z0-9]+-[a-z0-9]+$/.test(id || '')) return null;
  let entries = [];
  try { entries = fs.readdirSync(uploadDir(name), { withFileTypes: true }); } catch { return null; }
  const f = entries.find((d) => d.isFile() && d.name.startsWith(id + '__'));
  return f ? path.join(uploadDir(name), f.name) : null;
}
function receiveUpload(name, req) {
  return new Promise((resolve, reject) => {
    let original = 'file';
    try { original = decodeURIComponent(req.headers['x-filename'] || 'file'); } catch {}
    const safe = path.basename(original).replace(/[^\w.\- ]+/g, '_').slice(-120) || 'file';
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    fs.mkdirSync(uploadDir(name), { recursive: true });
    const file = path.join(uploadDir(name), `${id}__${safe}`);
    const out = fs.createWriteStream(file);
    let size = 0;
    req.on('data', (d) => {
      size += d.length;
      if (size > UPLOAD_LIMIT) { req.destroy(); out.destroy(); fs.rm(file, () => {}); reject(new Error('File is larger than 50 MB')); }
    });
    req.pipe(out);
    out.on('finish', () => resolve({ id, name: original, size, type: String(req.headers['content-type'] || '') }));
    out.on('error', reject);
  });
}
function pushChat(name, ev) {
  const chat = chatOf(name);
  chat.events.push(ev);
  if (chat.events.length > 800) chat.events.splice(0, chat.events.length - 800);
  emit({ t: 'claude', app: name, ev });
}

function shortTool(n) {
  const m = n.match(/^mcp__([^_]+(?:-[^_]+)*)__(.+)$/);
  return m ? `${m[1]} · ${m[2].replace(/^browser_/, '')}` : n;
}
function toolSummary(input = {}) {
  const v = input.url || input.file_path || input.path || input.command || input.pattern
    || input.element || input.text || input.description || input.query || input.key || '';
  return String(v).replace(/\s+/g, ' ').slice(0, 160);
}

async function askClaude(name, prompt, mode, fileIds = []) {
  const chat = chatOf(name);
  if (chat.proc) throw new Error('Claude is already working on this app.');
  const c = conf(name);
  const port = currentPort(name);
  const alias = domainOf(slug(name)) || `http://${slug(name)}.localhost:${HUB_PORT}/`;
  const ctx = [
    `You are working in the app folder ${name} at ${appDir(name)}, opened from Jinns, the user's local app launcher.`,
    port
      ? `This app is running right now at http://localhost:${port}/ (stable alias ${alias}). When a request involves the UI, use the Playwright browser tools to open it, click through it, and check what you changed. The dev server reloads on its own, so do not restart it.`
      : `This app is not running right now. The person can start it from Jinns at http://localhost:${HUB_PORT}/.`,
    'The person reads your replies in the Jinns chat panel, a web page that renders Markdown. They may attach files (screenshots, mockups, documents); read every attached file before acting on it. Keep the final reply short and plain.',
  ].join(' ');
  const files = [];
  for (const f of fileIds) {
    const p = findUpload(name, f.id);
    if (p) files.push({ ...f, path: p, size: fs.statSync(p).size });
  }
  const kb = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const fullPrompt = files.length
    ? `${prompt || 'See the attached files.'}\n\nAttached files (open each one with the Read tool):\n${files.map((f) => `- ${f.path} (${f.type || 'file'}, ${kb(f.size)})`).join('\n')}`
    : prompt;
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--mcp-config', MCP_FILE, '--append-system-prompt', ctx];
  if (files.length) args.push('--add-dir', uploadDir(name));
  if (mode === 'auto') args.push('--permission-mode', 'bypassPermissions');
  else if (mode === 'plan') args.push('--permission-mode', 'plan', '--allowedTools', 'mcp__playwright');
  else args.push('--permission-mode', 'acceptEdits', '--allowedTools', 'mcp__playwright,Bash(npm run:*),Bash(ls:*),Bash(git status:*),Bash(git diff:*)');
  if (c.sessionId) args.push('--resume', c.sessionId);

  pushChat(name, { k: 'you', text: prompt, mode, at: Date.now(), files: files.map(({ id, name: n, type, size }) => ({ id, name: n, type, size })) });
  const proc = spawnCli(await resolveBin(CLAUDE_BIN), args, { cwd: appDir(name), env: childEnv() });
  chat.proc = proc;
  emitStatus(name);
  proc.stdin.on('error', () => {}); // claude may exit before reading (not signed in, bad flag); 'close' reports it
  proc.stdin.end(fullPrompt);

  proc.stdout.on('data', lineSplitter((line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { return pushChat(name, { k: 'sys', text: line.slice(0, 400) }); }
    if (ev.session_id && c.sessionId !== ev.session_id) { c.sessionId = ev.session_id; saveState(); }
    if (ev.type === 'system' && ev.subtype === 'init') {
      const pw = (ev.mcp_servers || []).find((s) => s.name === 'playwright');
      pushChat(name, { k: 'sys', text: `${ev.model || 'claude'} · ${pw ? `playwright ${pw.status}` : 'no playwright'}` });
    } else if (ev.type === 'assistant') {
      for (const b of ev.message?.content || []) {
        if (b.type === 'text' && b.text.trim()) pushChat(name, { k: 'text', text: b.text });
        else if (b.type === 'tool_use') pushChat(name, { k: 'tool', name: shortTool(b.name), summary: toolSummary(b.input) });
      }
    } else if (ev.type === 'user') {
      for (const b of ev.message?.content || []) {
        if (b.type === 'tool_result' && b.is_error) {
          const txt = Array.isArray(b.content) ? b.content.map((x) => x.text || '').join(' ') : String(b.content || '');
          pushChat(name, { k: 'toolerr', text: txt.slice(0, 300) });
        }
      }
    } else if (ev.type === 'result') {
      const denied = [...new Set((ev.permission_denials || []).map((d) => shortTool(d.tool_name)))];
      if (denied.length) pushChat(name, { k: 'warn', text: `Blocked by permission mode: ${denied.join(', ')}. Switch to "Full auto" to allow.` });
      pushChat(name, { k: 'done', ok: !ev.is_error, cost: ev.total_cost_usd, ms: ev.duration_ms, turns: ev.num_turns });
    }
  }));
  proc.stderr.on('data', lineSplitter((l) => pushChat(name, { k: 'err', text: stripAnsi(l).slice(0, 400) })));
  proc.on('error', (e) => pushChat(name, { k: 'err', text: `Could not run Claude Code (${CLAUDE_BIN}): ${e.message}. Is it installed? Run the setup script.` }));
  proc.on('close', (code) => {
    if (code && code !== 143) pushChat(name, { k: 'err', text: `claude exited with code ${code}` });
    chat.proc = null;
    saveChat(name);
    emitStatus(name);
  });
}

// ---------- <app>.jinns domains ----------
// macOS: Laravel Herd's nginx owns port 80 and forwards each <app>.jinns to Jinns.
// Windows: Jinns listens on port 80 itself (no admin needed there) and the hosts file
// maps each <app>.jinns to 127.0.0.1 (writing it needs admin once per new app).
// Either way Jinns routes by hostname, so app ports can change freely.
let domains = { mode: 'off', ready: false, names: new Set(), fix: null, folders: '' };
let domainSync = null;
let port80 = null;

async function herd(args, input = '') {
  const bin = await resolveBin(HERD_BIN);
  return new Promise((resolve) => {
    const proc = spawnCli(bin, args, { env: childEnv() });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    proc.on('error', () => resolve({ ok: false, out }));
    proc.on('close', (code) => resolve({ ok: code === 0, out }));
    proc.stdin.on('error', () => {}); // herd may exit before reading its input
    proc.stdin.end(input);
  });
}

// Herd is installed but not open yet: open it and wait for its CLI to answer.
async function herdUp() {
  if ((await herd(['proxies'])).ok) return true;
  if (!fs.existsSync('/Applications/Herd.app')) return false;
  spawn('open', ['-g', '-a', 'Herd'], { stdio: 'ignore' }).on('error', () => {});
  for (let i = 0; i < 20; i++) { await sleep(1500); if ((await herd(['proxies'])).ok) return true; }
  return false;
}

async function resolvesHere(host) {
  try { return (await dns.lookup(host, { family: 4 })).address === '127.0.0.1'; } catch { return false; }
}

// Herd only writes DNS settings for .test, so add the custom TLD ourselves.
async function ensureDnsmasq() {
  let text;
  try { text = fs.readFileSync(HERD_DNSMASQ, 'utf8'); } catch { return; }
  if (text.includes(`/.${TLD}/`)) return;
  fs.appendFileSync(HERD_DNSMASQ, `${text.endsWith('\n') ? '' : '\n'}address=/.${TLD}/127.0.0.1\n`);
  await herd(['restart', 'dnsmasq']);
}

async function syncHerd(want, folders) {
  if (!(await herdUp())) {
    return { mode: 'off', ready: false, names: new Set(), folders,
      fix: { kind: 'info', text: `Install Laravel Herd (herd.laravel.com) and run setup to get .${TLD} names. Apps still work at <app>.localhost:${HUB_PORT}.` } };
  }
  if (!(await herd(['tld'])).out.trim().split('\n').pop().includes(TLD)) {
    return { mode: 'herd', ready: false, names: new Set(), folders,
      fix: { kind: 'button', text: `Herd is not set up for .${TLD} names yet.`, button: `Turn on .${TLD} names` } };
  }
  const list = await herd(['proxies']);
  await ensureDnsmasq();
  const target = `http://127.0.0.1:${HUB_PORT}`;
  const have = new Map();
  for (const row of list.out.split('\n')) {
    const c = row.split('|').map((s) => s.trim());
    if (c.length >= 5 && c[1] && c[1] !== 'Site') have.set(c[1], c[4]);
  }
  for (const n of want) {
    if (have.has(n) && have.get(n) !== target) continue; // someone else's Herd proxy, leave it
    if (!have.has(n) && (await herd(['proxy', n, target])).ok) have.set(n, target);
  }
  for (const [n, host] of have) {
    if (host === target && !want.has(n) && (await herd(['unproxy', n])).ok) have.delete(n);
  }
  const ready = await resolvesHere(`${HOME_NAME}.${TLD}`);
  return {
    mode: 'herd', ready, folders,
    names: new Set([...have].filter(([, h]) => h === target).map(([n]) => n)),
    fix: ready ? null : {
      kind: 'button',
      text: `One step left for .${TLD} names. Your Mac asks for your password once.`,
      button: `Turn on .${TLD} names`,
    },
  };
}

async function syncHosts(want, folders) {
  if (!port80?.listening) {
    return { mode: 'off', ready: false, names: new Set(), folders,
      fix: { kind: 'info', text: `Port 80 is used by another program (often IIS), so .${TLD} names are off. Apps still work at <app>.localhost:${HUB_PORT}.` } };
  }
  const names = new Set();
  await Promise.all([...want].map(async (n) => { if (await resolvesHere(`${n}.${TLD}`)) names.add(n); }));
  const missing = [...want].filter((n) => !names.has(n));
  return {
    mode: 'hosts', ready: names.has(HOME_NAME), names, folders,
    fix: missing.length ? {
      kind: 'button',
      text: `${missing.length === want.size ? `Turn on .${TLD} names` : `${missing.length} new app${missing.length > 1 ? 's need' : ' needs'} a .${TLD} name`}. Windows asks for admin once to update the hosts file.`,
      button: `Add .${TLD} names`,
    } : null,
  };
}

function syncDomains() {
  domainSync ??= (async () => {
    const folders = listFolders();
    const want = new Set([HOME_NAME, ...folders.map(slug)]);
    if (IS_MAC) domains = await syncHerd(want, folders.join('/'));
    else if (IS_WIN) domains = await syncHosts(want, folders.join('/'));
  })().catch((e) => console.error(`Domain sync failed: ${e.message}`))
    .finally(() => { domainSync = null; emit({ t: 'reload' }); });
  return domainSync;
}

// The one step that needs admin rights, behind the system's own prompt.
async function fixDomains() {
  if (IS_MAC) {
    if (!(await herd(['tld'])).out.includes(TLD)) await herd(['tld', TLD], 'y\n'); // Herd asks to confirm custom TLDs
    await ensureDnsmasq();
    if (!fs.existsSync(`/etc/resolver/${TLD}`)) {
      // macOS asks Herd's DNS (127.0.0.1) about .jinns only once this file exists.
      const cmd = `mkdir -p /etc/resolver && echo nameserver 127.0.0.1 > /etc/resolver/${TLD}`;
      const prompt = `Jinns wants to turn on .${TLD} addresses for your local apps.`;
      await new Promise((resolve) => execFile('osascript',
        ['-e', `do shell script "${cmd}" with administrator privileges with prompt "${prompt}"`], () => resolve()));
    }
    return syncDomains();
  }
  if (!IS_WIN) throw new Error(`.${TLD} names are not supported on this system. Use <app>.localhost:${HUB_PORT}.`);
  const names = [HOME_NAME, ...listFolders().map(slug)].join(',');
  const script = path.join(HERE, 'scripts', 'hosts.ps1');
  // Start-Process -Verb RunAs shows the Windows admin prompt; the script then edits the hosts file.
  const ps = `Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','"${script}"','-Names','${names}','-Tld','${TLD}')`;
  const proc = spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { windowsHide: true });
  proc.on('close', () => syncDomains());
}

// ---------- reverse proxy: <slug>.jinns and <slug>.localhost:HUB_PORT -> app port ----------
const APP_HOST = new RegExp(`^(?:www\\.)?([a-z0-9-]+)\\.(?:localhost|${TLD})$`);
function hostOf(req) { return (req.headers.host || '').replace(/:\d+$/, '').toLowerCase(); }
function proxyTarget(req) {
  const host = hostOf(req);
  if (HOME_HOSTS.has(host)) return null;
  const m = host.match(APP_HOST);
  if (!m) return null;
  const name = listFolders().find((n) => slug(n) === m[1]);
  return { name, slug: m[1], port: name ? currentPort(name) : null };
}

function proxyHttp(t, req, res) {
  if (!t.port) {
    res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><body style="font:16px system-ui;padding:40px"><h2>${t.name || t.slug} is not running</h2>
      <p><a href="${homeUrl()}#${encodeURIComponent(t.name || '')}">Open Jinns to start it →</a></p>`);
  }
  const headers = { ...req.headers, host: `localhost:${t.port}` };
  for (const h of ['connection', 'upgrade', 'keep-alive', 'proxy-connection']) delete headers[h];
  const up = http.request({ host: 'localhost', port: t.port, method: req.method, path: req.url, headers, autoSelectFamily: true },
    (pres) => { res.writeHead(pres.statusCode, pres.headers); pres.pipe(res); });
  up.on('error', (e) => { if (!res.headersSent) res.writeHead(502); res.end(`Proxy error: ${e.message}`); });
  req.pipe(up);
}

function proxyUpgrade(t, req, socket, head) {
  if (!t?.port) return socket.destroy();
  const up = net.connect({ host: 'localhost', port: t.port, autoSelectFamily: true }, () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries({ ...req.headers, host: `localhost:${t.port}` })) {
      for (const one of [].concat(v)) raw += `${k}: ${one}\r\n`;
    }
    up.write(raw + '\r\n');
    if (head?.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
}

// ---------- HTTP API ----------
function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (d) => { s += d; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); } });
  });
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); // ['api', ...]
  const [, area, name, action] = parts;

  if (req.method === 'GET' && area === 'events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(': hi\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clients.delete(res); clearInterval(ping); });
    return;
  }
  if (req.method === 'GET' && area === 'apps' && !name) {
    await scanExternal();
    const folders = listFolders();
    if (url.searchParams.has('rescan') || domains.folders !== folders.join('/')) syncDomains();
    return json(res, 200, {
      root: ROOT, hubPort: HUB_PORT, tld: TLD, home: homeUrl(), platform: process.platform,
      domains: { mode: domains.mode, ready: domains.ready, fix: domains.fix },
      apps: folders.map(appInfo),
    });
  }
  if (area === 'domains') {
    if (req.method !== 'POST' || req.headers['x-jinns'] !== '1') return json(res, 403, { error: 'Forbidden' });
    try { await fixDomains(); return json(res, 200, { ok: true }); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (name && !listFolders().includes(name)) return json(res, 404, { error: `No app folder "${name}"` });
  if (req.method === 'GET' && area === 'logs') return json(res, 200, { lines: logs.get(name) || [] });
  if (req.method === 'GET' && area === 'upload' && action) {
    const file = findUpload(name, action);
    if (!file) return json(res, 404, { error: 'No such attachment' });
    return sendFile(file, res);
  }
  if (req.method === 'GET' && area === 'claude') {
    const chat = chatOf(name);
    return json(res, 200, { events: chat.events, running: !!chat.proc, hasSession: !!conf(name).sessionId });
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  // Custom header forces a CORS preflight, so other websites cannot drive Jinns.
  if (req.headers['x-jinns'] !== '1') return json(res, 403, { error: 'Missing X-Jinns header' });
  if (area === 'upload') {
    try { return json(res, 200, await receiveUpload(name, req)); } catch (e) { return json(res, 413, { error: e.message }); }
  }
  const body = await readBody(req);
  try {
    if (area === 'apps') {
      if (action === 'start') await startApp(name);
      else if (action === 'stop') stopApp(name);
      else if (action === 'restart') await restartApp(name);
      else if (action === 'install') {
        const cmd = body.cmd || appInfo(name).install || 'npm install';
        spawnProc(name, cmd, { phase: 'installing' });
      }
      else if (action === 'config') {
        const c = conf(name);
        if ('cmd' in body) { if (body.cmd?.trim()) c.cmd = body.cmd.trim(); else delete c.cmd; }
        if ('port' in body) { const p = Number(body.port); if (p > 1024 && p < 65536) c.port = p; else delete c.port; }
        saveState();
      }
      else if (action === 'reveal') openPath(appDir(name));
      else if (action === 'code') shellSpawn('code .', { cwd: appDir(name), stdio: 'ignore' }).on('error', () => {});
      else return json(res, 404, { error: 'Unknown action' });
      emitStatus(name);
      return json(res, 200, { ok: true, app: appInfo(name) });
    }
    if (area === 'claude') {
      const chat = chatOf(name);
      if (!action) {
        const fileIds = Array.isArray(body.files) ? body.files.filter((f) => f && typeof f.id === 'string').slice(0, 20) : [];
        if (!body.prompt?.trim() && !fileIds.length) return json(res, 400, { error: 'Empty instruction' });
        await askClaude(name, String(body.prompt || '').trim(), body.mode, fileIds);
      } else if (action === 'stop') chat.proc && killTree(chat.proc.pid);
      else if (action === 'reset') {
        if (chat.proc) killTree(chat.proc.pid);
        chat.events = [];
        saveChat(name);
        fs.rm(uploadDir(name), { recursive: true, force: true }, () => {});
        delete conf(name).sessionId; saveState();
        emit({ t: 'claude-reset', app: name });
      }
      emitStatus(name);
      return json(res, 200, { ok: true });
    }
  } catch (e) {
    log(name, `[jinns] ${e.message}`, 'err');
    return json(res, 400, { error: e.message });
  }
  json(res, 404, { error: 'Not found' });
}

async function handle(req, res) {
  const t = proxyTarget(req);
  if (t) return proxyHttp(t, req, res);
  if (!HOME_HOSTS.has(hostOf(req))) { res.writeHead(403); return res.end('Forbidden host'); }
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname === '/' || url.pathname === '/index.html') return sendFile(path.join(HERE, 'public', 'index.html'), res);
    res.writeHead(404); res.end();
  } catch (e) {
    json(res, 500, { error: e.message });
  }
}
const onUpgrade = (req, socket, head) => proxyUpgrade(proxyTarget(req), req, socket, head);

export function homeUrl() {
  return domains.ready ? `http://${HOME_NAME}.${TLD}/` : `http://localhost:${HUB_PORT}/`;
}

// ---------- start / stop ----------
// Resolves once the hub is listening. `domains` resolves when the .<tld> check is done
// (it can take a while if Herd has to be opened first).
let hubServer = null;
const timers = [];
export function startHub() {
  if (hubServer) return Promise.resolve({ url: `http://localhost:${HUB_PORT}/`, domains: Promise.resolve(domainStatus()) });
  writeMcpConfig();
  const server = http.createServer(handle);
  server.on('upgrade', onUpgrade);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // 127.0.0.1, not 'localhost': Herd's nginx proxies to IPv4 and Node may resolve localhost to ::1 only.
    server.listen(HUB_PORT, '127.0.0.1', () => {
      hubServer = server;
      timers.push(setInterval(() => scanExternal().catch(() => {}), 5000));
      // Pick up the domain setup step (and new hosts entries) without a restart.
      timers.push(setInterval(() => { if (domains.fix && domains.mode !== 'off' && !domainSync) syncDomains(); }, 15000));
      const domainsDone = (async () => {
        if (IS_WIN) {
          port80 = http.createServer(handle);
          port80.on('upgrade', onUpgrade);
          await new Promise((ok) => {
            port80.once('error', () => { port80 = null; ok(); });
            port80.listen(80, '127.0.0.1', ok);
          });
        }
        await syncDomains();
        return domainStatus();
      })();
      resolve({ url: `http://localhost:${HUB_PORT}/`, domains: domainsDone });
    });
  });
}
function domainStatus() { return { home: homeUrl(), ready: domains.ready, notice: domains.fix }; }

// Stops every app and Claude run Jinns started, and the hub itself. The caller decides when to exit.
export function stopAll() {
  for (const t of timers.splice(0)) clearInterval(t);
  for (const r of runs.values()) {
    if (r.server) r.server.close();
    else if (r.proc && r.proc.exitCode === null) killTree(r.pid);
  }
  for (const chat of chats.values()) if (chat.proc) killTree(chat.proc.pid);
  hubServer?.close(); hubServer = null;
  port80?.close(); port80 = null;
}
