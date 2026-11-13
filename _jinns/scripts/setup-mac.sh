#!/bin/bash
# Jinns setup for macOS. Start it by double-clicking setup.command in the Jinns folder.
# Checks and installs what Jinns needs, then turns on <app>.jinns addresses through Laravel Herd.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TLD=jinns
DNSMASQ="$HOME/Library/Application Support/Herd/config/dnsmasq/dnsmasq.conf"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/Library/Application Support/Herd/bin:$PATH"

step() { printf '\n\033[36m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32mOK\033[0m  %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m   %s\n' "$1"; }
ask()  { read -r -p "  $1 [Y/n] " a; [[ -z "$a" || "$a" =~ ^[Yy] ]]; }
has()  { command -v "$1" >/dev/null 2>&1; }

printf '\n\033[1mJinns setup\033[0m\nFolder: %s\n' "$ROOT"

step "1. Node.js (runs Jinns)"
if ! has node || ! node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)'; then
  warn "Node.js 20 or newer is needed."
  if has brew && ask "Install Node.js with Homebrew now?"; then brew install node; fi
  has node || { warn "Get Node.js from https://nodejs.org (LTS), then run setup again."; exit 1; }
fi
ok "Node.js $(node -v)"

step "2. Claude Code"
if ! has claude && ask "Install Claude Code now?"; then
  curl -fsSL https://claude.ai/install.sh | bash
fi
if has claude; then
  ok "Claude Code $(claude --version)"
  echo '      If you have never signed in, open Terminal, run "claude" once and follow the browser sign-in.'
else
  warn "Claude Code is missing. The Claude tab in Jinns will not work until it is installed."
fi

step "3. Google Chrome (the browser Claude drives through Playwright)"
if [ -d "/Applications/Google Chrome.app" ] || [ -d "$HOME/Applications/Google Chrome.app" ]; then
  ok "Chrome found"
elif has brew && ask "Install Google Chrome with Homebrew now?"; then
  brew install --cask google-chrome
else
  warn "Without Chrome, Claude cannot open your apps in a browser. Get it from https://google.com/chrome"
fi

step "4. Playwright for Claude"
if npx -y @playwright/mcp@latest --version >/dev/null 2>&1; then ok "Playwright MCP downloaded"
else warn "Could not download @playwright/mcp. Jinns will try again on first use."; fi

step "5. .$TLD addresses (needs Laravel Herd, free)"
if [ ! -d /Applications/Herd.app ]; then
  if has brew && ask "Install Laravel Herd with Homebrew now?"; then brew install --cask herd; fi
fi
if [ ! -d /Applications/Herd.app ]; then
  warn "No Herd, so apps open at <app>.localhost:4747 instead. Install Herd from https://herd.laravel.com and run setup again."
else
  open -g -a Herd
  for _ in $(seq 1 40); do herd proxies >/dev/null 2>&1 && break; sleep 1.5; done
  if ! herd proxies >/dev/null 2>&1; then
    warn "Herd did not start. Open the Herd app once, finish its first-run steps, then run setup again."
  else
    current="$(herd tld 2>/dev/null | tail -1 | tr -d '[:space:]')"
    if [ "$current" != "$TLD" ]; then
      echo "  Herd's sites will use .$TLD instead of .$current (undo later with: herd tld $current)."
      echo y | herd tld "$TLD" >/dev/null
    fi
    grep -q "/.$TLD/" "$DNSMASQ" 2>/dev/null || { printf 'address=/.%s/127.0.0.1\n' "$TLD" >> "$DNSMASQ"; herd restart dnsmasq >/dev/null; }
    if [ ! -f "/etc/resolver/$TLD" ]; then
      echo "  Your Mac password is needed once, so macOS sends .$TLD names to Herd:"
      sudo mkdir -p /etc/resolver && echo "nameserver 127.0.0.1" | sudo tee "/etc/resolver/$TLD" >/dev/null
    fi
    [ -f "/etc/resolver/$TLD" ] && ok "home.$TLD and <app>.$TLD are ready (Jinns registers each app with Herd)" \
      || warn "Skipped. Jinns shows a button to finish this later."
  fi
fi

step "Done"
echo "  Start Jinns any time with jinns.command. Add an app by putting its folder in $ROOT."
if ask "Open Jinns now?"; then exec "$ROOT/jinns.command"; fi
