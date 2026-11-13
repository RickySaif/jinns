#!/usr/bin/env node
// Jinns from a terminal: `node server.mjs [--open]`. jinns.command and jinns.cmd run this.
// The engine is hub.mjs; a desktop app would be a second launcher like this one. See ARCHITECTURE.md.
import { HUB_PORT, ROOT } from './config.mjs';
import { startHub, stopAll, openPath } from './hub.mjs';

const OPEN = process.argv.includes('--open');

try {
  const hub = await startHub();
  console.log(`\n  Jinns         →  ${hub.url}`);
  console.log(`  Apps folder   →  ${ROOT}\n`);
  const d = await hub.domains;
  if (d.ready) console.log(`  Also at       →  ${d.home}\n`);
  else if (d.notice) console.log(`  ${d.notice.text}${d.notice.command ? `\n  ${d.notice.command}` : ''}\n`);
  if (OPEN) openPath(d.home);
} catch (e) {
  if (e.code === 'EADDRINUSE' && OPEN) {
    // Jinns is already running: just open it.
    const home = await fetch(`http://127.0.0.1:${HUB_PORT}/api/apps`).then((r) => r.json()).then((j) => j.home).catch(() => null);
    openPath(home || `http://localhost:${HUB_PORT}/`);
    setTimeout(() => process.exit(0), 300);
  } else {
    console.error(`Jinns could not start: ${e.message}`);
    process.exit(1);
  }
}

const quit = () => { stopAll(); setTimeout(() => process.exit(0), 300); };
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
