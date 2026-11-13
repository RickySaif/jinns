#!/bin/zsh -l
# Double-click to open Jinns. First time? Run setup.command.
cd "$(dirname "$0")/_jinns" || exit 1
command -v node >/dev/null || { echo "Node.js is not installed. Run setup.command first."; read -r; exit 1; }
exec node server.mjs --open
