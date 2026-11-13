// Pure helpers for reading process and port lists. Kept apart from server.mjs so they can be
// tested on any OS (see test.mjs), including the Windows output format.

// Both platforms are first turned into "P pid ppid" and "L pid port" lines.
export const WIN_SNAPSHOT_PS = [
  "Get-CimInstance Win32_Process | ForEach-Object { 'P ' + $_.ProcessId + ' ' + $_.ParentProcessId }",
  "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { 'L ' + $_.OwningProcess + ' ' + $_.LocalPort }",
].join('; ');

export function parseSnapshot(text) {
  const parent = new Map(), listen = new Map();
  for (const line of text.split(/\r?\n/)) {
    const [kind, a, b] = line.trim().split(/\s+/);
    const x = Number(a), y = Number(b);
    if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
    if (kind === 'P') parent.set(x, y);
    else if (kind === 'L') { if (!listen.has(x)) listen.set(x, new Set()); listen.get(x).add(y); }
  }
  return { parent, listen };
}

// `ps -A -o pid=,ppid=` output to P lines.
export function psToLines(ps) {
  return ps.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => `P ${l}`).join('\n');
}

// `lsof -Fpn` output (p<pid> then n<addr:port> records) to L lines.
export function lsofToLines(lsof) {
  const lines = [];
  let pid;
  for (const l of lsof.split('\n')) {
    if (l[0] === 'p') pid = Number(l.slice(1));
    else if (l[0] === 'n' && pid) { const m = l.match(/:(\d+)$/); if (m) lines.push(`L ${pid} ${m[1]}`); }
  }
  return lines.join('\n');
}

// A process and all its descendants.
export function treeOf(root, parent) {
  const kids = new Map();
  for (const [p, pp] of parent) { if (p === pp) continue; if (!kids.has(pp)) kids.set(pp, []); kids.get(pp).push(p); }
  const seen = new Set([root]);
  const out = [root];
  for (let i = 0; i < out.length; i++) for (const k of kids.get(out[i]) || []) if (!seen.has(k)) { seen.add(k); out.push(k); }
  return out;
}

// Ports listened on by a process tree, lowest first.
export function treePorts(root, snap) {
  return [...new Set(treeOf(root, snap.parent).flatMap((p) => [...(snap.listen.get(p) || [])]))].sort((a, b) => a - b);
}

// Folder name to the name used in <name>.jinns. Must match slug() in scripts/setup.ps1.
export const slug = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';

// Quote one argument for cmd.exe when a .cmd/.bat has to go through the shell on Windows.
// Jinns never passes user text this way (instructions go through stdin), only paths and flags.
export const cmdQuote = (a) => `"${String(a).replace(/"/g, "'")}"`;
