@echo off
rem Double-click to open Jinns. First time? Run setup.cmd.
cd /d "%~dp0_jinns"
where node >nul 2>nul || (echo Node.js is not installed. Run setup.cmd first. & pause & exit /b 1)
node server.mjs --open
if errorlevel 1 pause
