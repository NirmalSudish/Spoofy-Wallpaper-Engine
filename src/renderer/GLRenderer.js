/**
 * GLRenderer
 * ----------
 * Full WebGL rendering pipeline:
 *
 *  1. Render text canvas → Texture A (text layer)
 *  2. Render [TextureA + Feedback ping] through main effect shader → FBO pong
 *  3. Blit FBO pong to screen
 *  4. Swap ping ↔ pong  (TouchDesigner-style Feedback TOP)
 *
 * Uniforms driven by: SentimentEngine params + AudioReactivity bands + time
 */
import { SHADERS, buildProgram } from '../shaders/ShaderLoader.js';

export class GLRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl     = null;

    // Programs
    this._progMain = null;
    this._progBlit = null;

    // Geometry
    this._quadBuf  = null;

    // Textures
    this._texText  = null;   // text canvas texture
    this._fboPing  = null;   // feedback FBO A
    this._fboPong  = null;   // feedback FBO B
    this._pingActive = true; // which FBO is the "read" feedback source

    // Uniform locations (main program)
    this._u = {};

    // Internal time counter
    this._startTime = performance.now();
  }

  // ────────────────────────────────────────────────────────────────────────
  async init() {
    const gl = this.canvas.getContext('webgl', {
      alpha:                 false,
      antialias:             false,
      depth:                 false,
      stencil:               false,
      premultipliedAlpha:    false,
      preserveDrawingBuffer: false,
    });

    if (!gl) throw new Error('WebGL not supported');
    this.gl = gl;

    // Check for required extension
    this._floatExt = gl.getExtension('OES_texture_float') ||
                     gl.getExtension('OES_texture_half_float');

    // Build shader programs
    this._progMain = buildProgram(gl, SHADERS.vertex, SHADERS.fragmentMain);
    this._progBlit = buildProgram(gl, SHADERS.vertex, SHADERS.fragmentBlit);

    // Cache uniform locations for main program
    gl.useProgram(this._progMain);
    const uniforms = [
      'uTextTexture','uFeedback','uTime',
      'uSentiment','uBass','uMid','uHigh',
      'uDistortion','uNoiseFreq','uNoiseSpeed',
      'uFeedbackDecay','uGlowStrength','uRGBShift',
      'uGlitch','uMoodColor',
      // Effect uniforms (batch 1)
      'uBeatPulse','uScanlines','uRainbow','uOuterGlowMult',
      // Effect uniforms (batch 2 — new)
      'uRefraction','uCaustics','uPerspTilt','uIridescence','uGodRays',
    ];
    uniforms.forEach(name => {
      this._u[name] = gl.getUniformLocation(this._progMain, name);
    });

    // Full-screen quad (-1,-1 → +1,+1)
    this._quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  1, -1, -1,  1,
       1, -1,  1,  1, -1,  1,
    ]), gl.STATIC_DRAW);

    // Textures
    this._texText = this._createTexture();
    this._fboPing = this._createFBO();
    this._fboPong = this._createFBO();

    // No depth/blending needed — all done in shaders
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    console.log('[GL] WebGL renderer initialised.');
  }

  resize(w, h) {
    if (!this.gl) return;
    const gl = this.gl;
    gl.viewport(0, 0, w, h);
    // Recreate FBOs at new resolution
    this._destroyFBO(this._fboPing);
    this._destroyFBO(this._fboPong);
    this._fboPing = this._createFBO(w, h);
    this._fboPong = this._createFBO(w, h);
  }

  /**
   * Main render call — invoked every frame.
   * @param {Object} state
   *   textCanvas   : HTMLCanvasElement (source bitmap)
   *   sentiment    : float  -1…+1
   *   moodColor    : [r,g,b]
   *   params       : visual params from SentimentEngine
   *   bass/mid/high: 0…1
   *   glitch       : 0…1
   */
  render(state) {
    const gl = this.gl;
    if (!gl) return;

    const w = this.canvas.width;
    const h = this.canvas.height;
    const t = (performance.now() - this._startTime) / 1000;

    // ── 1. Upload text canvas as texture ──────────────────────────────────
    // Flip Y so Canvas2D (y-down) maps correctly to WebGL UV (y-up)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.bindTexture(gl.TEXTURE_2D, this._texText);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, state.textCanvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    // ── 2. Which FBO is read (feedback) vs write (current output) ─────────
    const readFBO  = this._pingActive ? this._fboPing : this._fboPong;
    const writeFBO = this._pingActive ? this._fboPong : this._fboPing;

    // ── 3. Main effect pass → write FBO ───────────────────────────────────
    gl.bindFramebuffer(gl.FRAMEBUFFER, writeFBO.fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this._progMain);

    this._bindQuad(this._progMain);

    // Texture unit 0 = text, unit 1 = feedback
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._texText);
    gl.uniform1i(this._u.uTextTexture, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, readFBO.tex);
    gl.uniform1i(this._u.uFeedback, 1);

    // Time
    gl.uniform1f(this._u.uTime, t);

    // Audio
    gl.uniform1f(this._u.uBass,  state.bass  || 0);
    gl.uniform1f(this._u.uMid,   state.mid   || 0);
    gl.uniform1f(this._u.uHigh,  state.high  || 0);

    // Sentiment
    gl.uniform1f(this._u.uSentiment, state.sentiment || 0);

    // Mood color
    const mc = state.moodColor || [0.4, 0.7, 1.0];
    gl.uniform3f(this._u.uMoodColor, mc[0], mc[1], mc[2]);

    // Visual params from SentimentEngine
    const p = state.params || {};
    gl.uniform1f(this._u.uDistortion,    p.distortion    ?? 0.008);
    gl.uniform1f(this._u.uNoiseFreq,     p.noiseFreq     ?? 1.8);
    gl.uniform1f(this._u.uNoiseSpeed,    p.noiseSpeed    ?? 0.5);
    gl.uniform1f(this._u.uFeedbackDecay, p.feedbackDecay ?? 0.90);
    gl.uniform1f(this._u.uGlowStrength,  p.glowStrength  ?? 1.0);
    gl.uniform1f(this._u.uRGBShift,      p.rgbShift      ?? 0.002);

    // Keyword triggers
    gl.uniform1f(this._u.uGlitch, state.glitch || 0);

    // Effect uniforms (batch 1)
    gl.uniform1f(this._u.uBeatPulse,     state.beatPulse     ?? 0);
    gl.uniform1f(this._u.uScanlines,     state.scanlines     ?? 0);
    gl.uniform1f(this._u.uRainbow,       state.rainbow       ?? 0);
    gl.uniform1f(this._u.uOuterGlowMult, state.outerGlowMult ?? 1.0);
    // Effect uniforms (batch 2 — new)
    gl.uniform1f(this._u.uRefraction,    state.refraction    ?? 0);
    gl.uniform1f(this._u.uCaustics,      state.caustics      ?? 0);
    gl.uniform1f(this._u.uPerspTilt,     state.perspTilt     ?? 0);
    gl.uniform1f(this._u.uIridescence,   state.iridescence   ?? 0);
    gl.uniform1f(this._u.uGodRays,       state.godRays       ?? 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // ── 4. Blit write FBO → screen ─────────────────────────────────────────
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this._progBlit);

    this._bindQuad(this._progBlit);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, writeFBO.tex);
    gl.uniform1i(gl.getUniformLocation(this._progBlit, 'uSource'), 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // ── 5. Swap ping/pong ──────────────────────────────────────────────────
    this._pingActive = !this._pingActive;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  _bindQuad(prog) {
    const gl  = this.gl;
    const loc = gl.getAttribLocation(prog, 'aPosition');
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuf);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  }

  _createTexture() {
    const gl  = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,     gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,     gl.CLAMP_TO_EDGE);
    // 1×1 black placeholder
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0,0,0,255]));
    return tex;
  }

  _createFBO(w, h) {
    const gl  = this.gl;
    w = w || this.canvas.width  || 1920;
    h = h || this.canvas.height || 1080;

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,     gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,     gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      console.error('[GL] FBO incomplete:', status);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, tex, w, h };
  }

  _destroyFBO(fboObj) {
    if (!fboObj) return;
    const gl = this.gl;
    gl.deleteFramebuffer(fboObj.fbo);
    gl.deleteTexture(fboObj.tex);
  }
}
