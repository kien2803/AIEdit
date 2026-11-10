# AIEdit

Timeline-based video editor foundation designed to become an AI-native editor:
every edit is an immutable operation logged with context — the op log doubles
as behavioral training data for future edit-assist models.

## Stack

- `packages/core` — project model, op vocabulary, dispatcher (undo/redo + op log)
- `packages/engine` — playback clock, media pool, WebGL2 compositor, player
- `packages/ui` — React + zustand: timeline, preview, inspector, media bin
- `packages/export` — project → ffmpeg filter graph → MP4 (wasm runner)
- `apps/web` — Vite app

## Develop

```bash
pnpm install
pnpm dev          # http://localhost:5173
pnpm -r test      # unit + real-ffmpeg e2e tests
pnpm -r typecheck
```

See `AGENTS.md` for architecture conventions.
