@echo off
rem Cortex Live: run Cortex from this checkout with hot reload.
rem - Fast-forwards from GitHub first when it is safe (clean tree, no divergence).
rem - Installs dependencies only when package-lock.json changed.
rem - Source edits (yours or the agent's) hot-reload in the open window.
setlocal
cd /d "%~dp0.."
title Cortex Live

rem Launched from VS Code/Claude terminals this is inherited and makes Electron run as plain Node.
set ELECTRON_RUN_AS_NODE=

git fetch --quiet origin 2>nul
git diff --quiet && git diff --cached --quiet && (
  git merge --ff-only @{u} >nul 2>&1 && echo [live] synced with GitHub || echo [live] no fast-forward pull applied
) || echo [live] local changes present, skipping pull

if not exist node_modules (
  call npm install
) else (
  rem Reinstall only when the lockfile is newer than the last install (a byte compare never matches).
  powershell -NoProfile -Command "if ((Get-Item package-lock.json).LastWriteTime -gt (Get-Item node_modules\.package-lock.json).LastWriteTime) { exit 1 }" || call npm ci --no-audit --no-fund
)

call npm run dev
