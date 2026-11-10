import type { EffectInstance } from "@aiedit/core";

/**
 * EffectRegistry — the shared "vocabulary" between UI, renderer, exporter,
 * and (later) AI. Every effect declares params + how the compositor maps them.
 */
export interface EffectSpec {
  type: string;
  label: string;
  defaults: Record<string, number>;
  /** Map params -> compositor uniform block (see compositor.ts). */
  toUniforms: (p: Record<string, number>) => Partial<EffectUniforms>;
}

export interface EffectUniforms {
  exposure: number;    // EV
  contrast: number;    // 1 = neutral
  saturation: number;  // 1 = neutral
  temperature: number; // -1..1
  blurPx: number;
}

export const NEUTRAL_UNIFORMS: EffectUniforms = {
  exposure: 0,
  contrast: 1,
  saturation: 1,
  temperature: 0,
  blurPx: 0,
};

export const EFFECT_REGISTRY: Record<string, EffectSpec> = {
  "color.basic": {
    type: "color.basic",
    label: "Color",
    defaults: { exposure: 0, contrast: 1, saturation: 1, temperature: 0 },
    toUniforms: (p) => ({
      exposure: p["exposure"] ?? 0,
      contrast: p["contrast"] ?? 1,
      saturation: p["saturation"] ?? 1,
      temperature: p["temperature"] ?? 0,
    }),
  },
};

/** Fold a clip's enabled effects into one uniform block (later effects win/combine). */
export function uniformsFor(effects: EffectInstance[]): EffectUniforms {
  const u = { ...NEUTRAL_UNIFORMS };
  for (const e of effects) {
    if (!e.enabled) continue;
    const spec = EFFECT_REGISTRY[e.type];
    if (!spec) continue;
    Object.assign(u, spec.toUniforms(e.params));
  }
  return u;
}

export function makeEffect(type: string, id: string): EffectInstance {
  const spec = EFFECT_REGISTRY[type];
  if (!spec) throw new Error(`unknown effect type ${type}`);
  return { id, type, params: { ...spec.defaults }, enabled: true };
}
