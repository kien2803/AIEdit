# AIedit

Timeline-based video editor foundation, built to become an AI-native editor later.

## Layout (pnpm monorepo)

- `packages/core` — pure TS, zero DOM. Project document model (declarative EDL),
  operation vocabulary (`ops.ts`), dispatcher (undo/redo + append-only op log).
  The op log records every edit batch with context (playhead, selection, tool) —
  it is designed to become behavioral training data for AI. Do NOT change op
  semantics casually; bump `schemaVersion` for model changes.
- `packages/engine` — preview runtime: PlaybackClock, MediaPool (one media
  element per clip instance), WebGL2 Compositor, PreviewPlayer. `renderAt(t)`
  is the headless API an AI harness can call without UI.
- `packages/ui` — React + zustand: Timeline, Preview, Inspector, MediaBin,
  `useEditor` store. Drag interactions preview locally and dispatch ONE op
  batch on mouseup — keeps the op log semantically clean.
- `packages/export` — `buildExportPlan(project, textDims, opts)` maps the project
  to an ffmpeg filter graph (pure, unit+e2e tested). Runners: `WasmRunner`
  (browser, fetches pinned ffmpeg core from CDN — bundle locally under Tauri).
  Effect→ffmpeg mapping in `eqParams`/`audioChain` must stay in sync with the
  compositor's `EFFECT_REGISTRY`.
- `apps/web` — Vite dev/build app. (Tauri desktop shell planned; the frontend
  is shell-agnostic.)

## Commands

- `pnpm install` — install workspace deps
- `pnpm dev` — run the web app (vite, http://localhost:5173)
- `pnpm -r test` — vitest (core has the test suite)
- `pnpm -r typecheck` — tsc --noEmit everywhere
- `pnpm --filter @aiedit/web build` — production build

## Conventions

- Time is integer ticks at TIMESCALE=90_000 (`ticks.fromSeconds`). Never store
  float seconds in the model.
- All edits go through `dispatch(ops, label)` — never mutate project directly.
- New edit operations: add to the `Op` union in `core/src/ops.ts` with apply +
  inverse handling; inverses of clip mutations can use `clip.replace`.
- Placement rules (overlap clamp, trim clamp, ripple delete) live in
  `core/src/placement.ts` — UI calls them before dispatching, ops themselves
  stay semantics-only.
- Effects are declarative (`EffectInstance` + `EFFECT_REGISTRY` in
  `engine/src/effects.ts`) — registry = the vocabulary AI will later emit.

## Shortcuts

Space play/pause · V select · B blade · S split at playhead · T text ·
Del delete · Ctrl/Cmd+Z undo · Ctrl/Cmd+Shift+Z redo · ←/→ nudge (Shift=1s)
