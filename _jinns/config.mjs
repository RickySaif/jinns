// Every setting Jinns reads, in one place.
// Today they come from environment variables with repo-friendly defaults. A desktop app sets
// the same variables (for example JINNS_DATA to its user-data folder) before importing hub.mjs.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';

// Code (server, page, scripts). Read-only inside a packaged app, so nothing is written here
// unless DATA_DIR points at it, as it does by default in the repo.
export const CODE_DIR = path.dirname(fileURLToPath(import.meta.url));
// Everything Jinns writes: ports and commands, chats, uploads, generated config.
export const DATA_DIR = path.resolve(env.JINNS_DATA || CODE_DIR);
// The folder whose subfolders are the apps.
export const ROOT = path.resolve(env.JINNS_ROOT || path.join(CODE_DIR, '..'));

export const HUB_PORT = Number(env.JINNS_PORT || 4747);
export const PORT_BASE = Number(env.JINNS_PORT_BASE || 4800);
export const TLD = env.JINNS_TLD || 'jinns';
export const HOME_NAME = env.JINNS_HOME || 'home';
export const HOME_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', `${HOME_NAME}.${TLD}`, `${HOME_NAME}.localhost`]);

// External programs. A desktop app can point these at copies it ships.
export const CLAUDE_BIN = env.CLAUDE_BIN || 'claude';
export const HERD_BIN = env.HERD_BIN || 'herd';

export const STATE_FILE = path.join(DATA_DIR, 'jinns.json');
export const RUNTIME_DIR = path.join(DATA_DIR, '.runtime');
export const MCP_FILE = path.join(RUNTIME_DIR, 'mcp.json');
export const UPLOAD_DIR = path.join(RUNTIME_DIR, 'uploads');
export const CHAT_DIR = path.join(RUNTIME_DIR, 'chats');

const HOME_DIR = env.HOME || env.USERPROFILE || '';
export const HERD_DNSMASQ = path.join(HOME_DIR, 'Library/Application Support/Herd/config/dnsmasq/dnsmasq.conf');

export const UPLOAD_LIMIT = 50 << 20;
export const LOG_LIMIT = 1500;
