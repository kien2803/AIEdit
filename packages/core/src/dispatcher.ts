import type { Project } from "./model.js";
import { applyOps, applyRaw, defaultContext, type EditContext, type Op, type OpBatch } from "./ops.js";

/**
 * Framework-agnostic edit engine. Owns the project, applies ops, keeps
 * undo/redo stacks, and appends every batch (with context) to an op log.
 * The op log is append-only and doubles as the behavioral training corpus.
 */
export class Dispatcher {
  private _project: Project;
  private _undo: OpBatch[] = [];
  private _redo: OpBatch[] = [];
  private _log: OpBatch[] = [];
  private listeners = new Set<(p: Project) => void>();
  sessionId: string;

  constructor(project: Project, sessionId = `sess_${Date.now().toString(36)}`) {
    this._project = project;
    this.sessionId = sessionId;
  }

  get project(): Project {
    return this._project;
  }
  get log(): readonly OpBatch[] {
    return this._log;
  }
  get canUndo(): boolean {
    return this._undo.length > 0;
  }
  get canRedo(): boolean {
    return this._redo.length > 0;
  }

  subscribe(fn: (p: Project) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this._project);
  }

  dispatch(ops: Op[], label: string, ctx: Partial<EditContext> = {}): OpBatch {
    const context = defaultContext({ sessionId: this.sessionId, ...ctx });
    const { next, inverse } = applyOps(this._project, ops);
    const batch: OpBatch = { ops, inverse, context, label };
    this._project = next;
    this._undo.push(batch);
    this._redo = [];
    this._log.push(batch);
    this.emit();
    return batch;
  }

  undo(): boolean {
    const batch = this._undo.pop();
    if (!batch) return false;
    this._project = applyRaw(this._project, batch.inverse);
    this._redo.push(batch);
    this.emit();
    return true;
  }

  redo(): boolean {
    const batch = this._redo.pop();
    if (!batch) return false;
    const { next } = applyOps(this._project, batch.ops);
    this._project = next;
    this._undo.push(batch);
    this.emit();
    return true;
  }
}
