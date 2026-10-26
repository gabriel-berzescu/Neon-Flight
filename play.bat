@echo off
rem Neon-Flight launcher: builds if needed, then opens the game in its own Chrome window on the fast GPU.
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund
)
node scripts\play.mjs %*
