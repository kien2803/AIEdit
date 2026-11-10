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
- `packages/template` — template capture (selected clips → zero-based root +
  inferred params/bindings/time-rules) and `instantiateTemplate` → Op[].
  Elasticity rules ("stretch"/"fixed"/"fit") decide how segments react to new
  footage duration. Library persists to localStorage (v1).
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
- Model v2 (`schemaVersion: 2`): keyframes use `EaseSpec` objects
  (linear/hold/bezier/spring) via `key.set/remove/toggle` ops; `timeRemap`
  overrides `speed` in `sourceTimeAt`; `SceneClip` references `project.scenes`
  (must exist before clip.add); `AdjustmentClip` folds into the compositor's
  post pass; `transitions` = edge fades. Migration in `core/src/migrate.ts`.
- `applyOps` validates/computes inverses against the evolving batch state —
  ops may depend on earlier ops in the same batch.
- Export has two paths: filter-graph (pure footage) and frame-render
  (`buildFramePlan`, compositor→mjpeg→ffmpeg) auto-selected when the timeline
  contains SceneClip/AdjustmentClip.

## Shortcuts

Space play/pause · V select · B blade · S split at playhead · T text ·
Del delete · Ctrl/Cmd+Z undo · Ctrl/Cmd+Shift+Z redo · ←/→ nudge (Shift=1s)
