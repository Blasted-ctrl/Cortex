# Contributing / Developer guide

## Prerequisites
- Node 22.20.0 recommended (CI pin; Node 24.12.0 also verified). Build tooling
  requires `^20.19.0 || >=22.12.0`; Node 18 is no longer supported.
- npm (or pnpm)
- For compiling user programs: `g++`/`clang++`, `python`, `node` on your `PATH`

## Setup
```bash
cd customIDE
npm install
npm run dev
```

> **Gotcha:** if `ELECTRON_RUN_AS_NODE=1` is set in your shell, Electron launches as plain Node and
> the window never opens (`app` is undefined). Unset it: `unset ELECTRON_RUN_AS_NODE` (bash) /
> `Remove-Item Env:ELECTRON_RUN_AS_NODE` (PowerShell).

## Scripts
| Command | What it does |
|---|---|
| `npm run dev` | Launch with hot reload (electron-vite) |
| `npm run build` | Build main + preload + renderer into `out/` |
| `npm run typecheck` | Type-check node (main/preload) and web (renderer) projects |
| `npm test` | Run unit/store regressions and native filesystem, Git and compiler integration checks |
| `npm start` | Preview the production build |
| `npm run dist:win` | Package a Windows installer into `release/` |

## Project layout
```
src/
  main/                 Electron main process (Node)
    index.ts            window + all ipcMain handlers
    services/           fs, toolchain, runner, serial, ai, settings
  preload/              contextBridge → window.api (typed)
  renderer/             React app (Vite)
    index.html
    src/
      App.tsx           layout + IPC event wiring + shortcuts
      store/useStore.ts single Zustand store
      components/        panels & views
      styles/index.css   Tailwind + base styles
  shared/               types shared by both sides
    ipc.ts              channel names + payload types (the contract)
    languages.ts        language definitions
```

## How to add a feature that crosses the IPC boundary
1. **Define it** in `src/shared/ipc.ts`: add a channel name to `IPC` and any payload types.
2. **Handle it** in `src/main/index.ts` (`ipcMain.handle(...)`), delegating to a service in
   `src/main/services/`.
3. **Expose it** in `src/preload/index.ts` on the `api` object (keep it typed).
4. **Consume it** from `src/renderer/src/store/useStore.ts` via `window.api.*`, and render in a
   component.

## How to add a language
Edit `src/shared/languages.ts` - add a `LanguageDef` (id, Monaco language id, extensions, category,
`runnable`, color). If it should run, add a case in `src/main/services/runnerService.ts` `startRun`.

## How to add a sidebar panel
1. Create `src/renderer/src/components/YourPanel.tsx`.
2. Add a `SidebarView` id in `useStore.ts` and an entry in `ActivityBar.tsx`.
3. Render it in `SideBar.tsx`.

## Conventions
- TypeScript strict mode; keep the IPC surface fully typed (no `any` across the bridge).
- Tailwind for styling; use the `ide-*` palette tokens from `tailwind.config.js`.
- Keep the main process the only place with Node/native access; the renderer talks only through
  `window.api`.
- Run `npm run typecheck` before committing.
