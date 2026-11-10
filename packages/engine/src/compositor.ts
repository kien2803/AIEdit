import type { Clip, Project, Transform } from "@aiedit/core";
import { sample, ticks } from "@aiedit/core";
import type { TimeTicks } from "@aiedit/core";
import { uniformsFor, type EffectUniforms } from "./effects.js";
import type { MediaHandle } from "./mediaPool.js";

const VERT = `#version 300 es
precision highp float;
in vec2 aPos;     // quad corner -1..1
in vec2 aUV;
uniform mat3 uModel;   // model -> clip space
out vec2 vUV;
void main() {
  vec3 p = uModel * vec3(aPos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  vUV = aUV;
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform float uOpacity;
uniform float uExposure;
uniform float uContrast;
uniform float uSaturation;
uniform float uTemperature;
out vec4 frag;
void main() {
  vec4 c = texture(uTex, vUV);
  vec3 rgb = c.rgb * exp2(uExposure);
  rgb = (rgb - 0.5) * uContrast + 0.5;
  float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = mix(vec3(luma), rgb, uSaturation);
  rgb += vec3(uTemperature * 0.1, 0.0, -uTemperature * 0.1);
  frag = vec4(clamp(rgb, 0.0, 1.0), c.a * uOpacity);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(s) ?? "shader compile failed");
  }
  return s;
}

/**
 * WebGL2 compositor. Given the set of visual clips active at t, draws each as
 * a textured quad bottom-to-top (track order: last video track = bottom).
 */
export class Compositor {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private vbo: WebGLBuffer;
  private texCache = new WeakMap<object, WebGLTexture>();
  private fbo: WebGLFramebuffer;
  private fboTex: WebGLTexture;
  private W: number;
  private H: number;
  private uModel: WebGLUniformLocation;
  private uniforms: Record<string, WebGLUniformLocation | null>;

  constructor(private canvas: HTMLCanvasElement, project: Project) {
    this.W = project.settings.width;
    this.H = project.settings.height;
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL2 unavailable");
    this.gl = gl;

    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(prog) ?? "link failed");
    }
    this.prog = prog;
    gl.useProgram(prog);

    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    // pos.xy (NDC quad) + uv
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 0, 0,  1, -1, 1, 0,  -1, 1, 0, 1,
      -1, -1, 0, 0,  1, 1, 1, 1,   1, -1, 1, 0,
    ]), gl.STATIC_DRAW);
    this.vbo = vbo;
    const aPos = gl.getAttribLocation(prog, "aPos");
    const aUV = gl.getAttribLocation(prog, "aUV");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(aUV);
    gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 16, 8);

    this.uModel = gl.getUniformLocation(prog, "uModel")!;
    this.uniforms = {};
    for (const n of ["uTex", "uOpacity", "uExposure", "uContrast", "uSaturation", "uTemperature"]) {
      this.uniforms[n] = gl.getUniformLocation(prog, n);
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    // offscreen target for the post-process (adjustment) pass
    this.fboTex = gl.createTexture()!;
    this.fbo = gl.createFramebuffer()!;
    this.resizeCanvas();
  }

  /** Begin rendering into the offscreen buffer. */
  beginScene(): void {
    const gl = this.gl;
    const w = Math.max(2, this.canvas.width), h = Math.max(2, this.canvas.height);
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Blit the offscreen buffer to screen, applying post uniforms (adjustment layer). */
  finishScene(post: EffectUniforms): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    gl.uniform1i(this.u("uTex"), 0);
    gl.uniform1f(this.u("uOpacity"), 1);
    gl.uniform1f(this.u("uExposure"), post.exposure);
    gl.uniform1f(this.u("uContrast"), post.contrast);
    gl.uniform1f(this.u("uSaturation"), post.saturation);
    gl.uniform1f(this.u("uTemperature"), post.temperature);
    const identity = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    gl.uniformMatrix3fv(this.uModel, false, identity);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  resizeCanvas(): void {
    // canvas pixel size is managed by CSS/layout; keep backing store matched
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(this.canvas.clientWidth * dpr) || this.W;
    const h = Math.round(this.canvas.clientHeight * dpr) || this.H;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  private u(name: string): WebGLUniformLocation | null {
    return this.uniforms[name] ?? null;
  }

  clear(): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  private textureFor(source: TexImageSource, key: object): WebGLTexture | null {
    const gl = this.gl;
    let tex = this.texCache.get(key);
    if (!tex) {
      tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.texCache.set(key, tex);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, tex);
    }
    try {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } catch {
      return null; // element not ready (metadata not loaded)
    }
    return tex;
  }

  /**
   * Draw one visual clip. `source` is a video element or text canvas.
   * srcW/srcH = native pixels; the clip is scaled "contain" into the project
   * frame, then the clip transform applies on top.
   */
  drawClip(clip: Clip, handle: MediaHandle, source: TexImageSource, srcW: number, srcH: number, t: TimeTicks, opacityMul = 1): void {
    const gl = this.gl;
    const tex = this.textureFor(source, handle);
    if (!tex) return;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.u("uTex"), 0);

    const tr: Transform = sample(clip.transform, t - clip.start);
    const fx: EffectUniforms = uniformsFor(clip.effects);
    gl.uniform1f(this.u("uOpacity"), tr.opacity * opacityMul * (clip.enabled ? 1 : 0));
    gl.uniform1f(this.u("uExposure"), fx.exposure);
    gl.uniform1f(this.u("uContrast"), fx.contrast);
    gl.uniform1f(this.u("uSaturation"), fx.saturation);
    gl.uniform1f(this.u("uTemperature"), fx.temperature);

    // contain-fit into project frame
    const fit = Math.min(this.W / srcW, this.H / srcH);
    const w = srcW * fit * tr.scaleX;
    const h = srcH * fit * tr.scaleY;
    // model: scale to NDC, rotate, translate (project px -> NDC)
    const cos = Math.cos(tr.rotation), sin = Math.sin(tr.rotation);
    const sx = (w / 2) / (this.W / 2);
    const sy = (h / 2) / (this.H / 2);
    const tx = tr.x / (this.W / 2);
    const ty = -tr.y / (this.H / 2); // y down in project space
    // column-major mat3 for WebGL
    const m = new Float32Array([
      sx * cos, sx * sin, 0,
      -sy * sin, sy * cos, 0,
      tx, ty, 1,
    ]);
    gl.uniformMatrix3fv(this.uModel, false, m);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
}
