@echo off
rem Double-click to set up Jinns on this PC (Node.js, Claude Code, Chrome, .jinns addresses).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_jinns\scripts\setup.ps1"
pause
