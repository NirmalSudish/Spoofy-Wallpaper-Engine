/**
 * TextCanvas
 * ----------
 * Renders lyric text to an offscreen Canvas2D element.
 * The canvas is then uploaded as a WebGL texture by GLRenderer.
 *
 * Entrance styles (set via .entranceStyle):
 *   'sweep'      — horizontal gradient reveal (default)
 *   'rise'       — text slides up from below into position
 *   'wave'       — characters undulate with a sine wave, settles to subtle motion
 *   'typewriter' — characters appear one-by-one left to right
 */
import { TextEngine }    from '../text/TextEngine.js';
import { PretextHover } from '../text/PretextHover.js';

export class TextCanvas {
  constructor(canvas) {
    this.canvas  = canvas;
    this.ctx     = null;
    this.engine  = new TextEngine();
    this.hover   = new PretextHover();

    // Animation state
    this._displayLine       = '';
    this._pendingLine       = '';
    this._pendingMoodResult = null;
    this._lineAlpha         = 0;
    this._targetAlpha       = 1;
    this._scale             = 1.0;
    this._moodResult        = null;
    this._layout            = null;
    this._isFirstLine       = true;

    // Transition timing
    this._fadeSpeed  = 0.045;
    this._scaleSpeed = 0.06;
    this._swapReady  = false;

    // Time (for wave animation — increments each frame)
    this._time = 0;

    // Configurable effects (set by main.js from WE props)
    this.entranceStyle  = 'sweep';  // 'sweep' | 'rise' | 'wave' | 'typewriter'
    this.outlineWidth   = 0;        // 0 = disabled, 0.5–4 = stroke width in px
    this.waveAmplitude  = 14;       // peak wave offset in pixels
    this.extrusionDepth = 0;        // 0 = off, 1–10 = number of depth layers
  }

  init() {
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: false });
  }

  resize(w, h) {
    this.canvas.width  = w;
    this.canvas.height = h;
  }

  // ── Set a new lyric line (triggers fade-out → swap → fade-in) ────────────

  setLine(line, moodResult) {
    this._pendingLine = line;
    this.hover.reset();

    if (this._isFirstLine || !this._displayLine) {
      this._displayLine = line;
      this._moodResult  = moodResult;
      this._lineAlpha   = 0;
      this._targetAlpha = 1;
      this._scale       = 0.94;
      this._layout      = null;
      this._isFirstLine = false;
    } else {
      this._pendingMoodResult = moodResult;
      this._targetAlpha       = 0;
      this._swapReady         = true;
    }
  }

  // ── Main render (called every frame) ─────────────────────────────────────

  render(state) {
    const { ctx, canvas } = this;
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;

    this._time += 1 / 60;

    ctx.clearRect(0, 0, w, h);

    // ── Alpha / swap transition ───────────────────────────────────────────
    if (this._targetAlpha === 0) {
      this._lineAlpha = Math.max(0, this._lineAlpha - this._fadeSpeed);
      if (this._lineAlpha <= 0 && this._swapReady) {
        this._displayLine = this._pendingLine;
        this._moodResult  = this._pendingMoodResult;
        this._targetAlpha = 1;
        this._swapReady   = false;
        this._scale       = 0.92;
        this._layout      = null;
      }
    } else {
      this._lineAlpha = Math.min(1, this._lineAlpha + this._fadeSpeed);
    }

    // ── Scale bounce ──────────────────────────────────────────────────────
    if (this._scale < 1.0) {
      this._scale = Math.min(1.0, this._scale + this._scaleSpeed);
    }

    if (!this._displayLine) return;

    // ── Layout ────────────────────────────────────────────────────────────
    const moodParams = {
      textScale: (this._moodResult?.params?.textScale || 1.0) * this._scale,
      mood:      this._moodResult?.mood || 'calm',
    };
    const layout = this.engine.layout(this._displayLine, w, h, moodParams);

    const moodColor  = this._moodResult?.color || [0.4, 0.7, 1.0];
    const glowCSS    = this._rgbToCSS(moodColor, 0.75);
    const outlineCSS = this._rgbToCSS(moodColor, 1.0);

    ctx.save();
    ctx.font         = layout.font;
    ctx.textBaseline = 'alphabetic';

    // ── 3D extrusion pre-pass (depth layers behind the text) ─────────────
    if (this.extrusionDepth > 0 && this._lineAlpha > 0.01) {
      this._renderExtrusion(ctx, layout, moodColor);
    }

    const fullyVisible = this._targetAlpha === 1 && this._lineAlpha >= 0.95;

    // ── Hover (Pretext cursor-parting) — only when fully visible ─────────
    if (fullyVisible && this.hover.enabled) {
      const chunks = this.hover.update(layout, ctx);
      if (chunks.length > 0) {
        chunks.forEach(chunk => {
          ctx.globalAlpha = 1.0;
          // Boost glow on edge characters near cursor gap
          const bassBoost = chunk.hoverGlow * 0.6;
          this._drawText(ctx, chunk.text, chunk.x, chunk.y, glowCSS, outlineCSS, state.bass + bassBoost, chunk.align);
        });
      } else {
        // Safety fallback — hover returned nothing, render normally
        ctx.globalAlpha = 1.0;
        ctx.textAlign   = 'center';
        layout.lines.forEach((line, i) => {
          const y = layout.y + i * layout.lineHeight;
          this._drawText(ctx, line, layout.x, y, glowCSS, outlineCSS, state.bass, 'center');
        });
      }

    // ── Entrance / exit ───────────────────────────────────────────────────
    } else if (this._targetAlpha === 0) {
      // Uniform fade-out for all styles — fast and clean
      ctx.globalAlpha = Math.max(0, this._lineAlpha);
      ctx.textAlign   = 'center';
      layout.lines.forEach((line, i) => {
        const y = layout.y + i * layout.lineHeight;
        this._drawText(ctx, line, layout.x, y, glowCSS, outlineCSS, state.bass, 'center');
      });
    } else {
      switch (this.entranceStyle) {
        case 'rise':        this._renderRise(ctx, layout, glowCSS, outlineCSS, state); break;
        case 'wave':        this._renderWave(ctx, layout, glowCSS, outlineCSS, state); break;
        case 'typewriter':  this._renderTypewriter(ctx, layout, glowCSS, outlineCSS, state); break;
        default:            this._renderSweep(ctx, layout, glowCSS, outlineCSS, state, w, h); break;
      }
    }

    ctx.restore();
  }

  // ── Entrance: Sweep ───────────────────────────────────────────────────────

  _renderSweep(ctx, layout, glowCSS, outlineCSS, state, w, h) {
    ctx.globalAlpha = 1.0;
    ctx.textAlign   = 'center';

    layout.lines.forEach((line, i) => {
      const y = layout.y + i * layout.lineHeight;
      this._drawText(ctx, line, layout.x, y, glowCSS, outlineCSS, state.bass, 'center');
    });

    if (this._lineAlpha < 1.0) {
      ctx.globalCompositeOperation = 'destination-in';
      const gradient = ctx.createLinearGradient(w * 0.08, 0, w * 0.92, 0);
      const p      = this._lineAlpha;
      const spread = 0.28;
      gradient.addColorStop(Math.max(0, p * (1 + spread) - spread), 'rgba(0,0,0,1)');
      gradient.addColorStop(Math.min(1, p * (1 + spread)),           'rgba(0,0,0,0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, w, h);
    }
  }

  // ── Entrance: Rise ────────────────────────────────────────────────────────

  _renderRise(ctx, layout, glowCSS, outlineCSS, state) {
    const yOff = (1.0 - this._easeOut(this._lineAlpha)) * 40;
    ctx.globalAlpha = this._lineAlpha;
    ctx.textAlign   = 'center';

    layout.lines.forEach((line, i) => {
      const y = layout.y + i * layout.lineHeight + yOff;
      this._drawText(ctx, line, layout.x, y, glowCSS, outlineCSS, state.bass, 'center');
    });
  }

  // ── Entrance: Wave ────────────────────────────────────────────────────────

  _renderWave(ctx, layout, glowCSS, outlineCSS, state) {
    ctx.globalAlpha = this._lineAlpha;
    ctx.textAlign   = 'left';

    const t   = this._time;
    // Large wave during entrance, settles to subtle persistent motion
    const amp = this.waveAmplitude * (this._lineAlpha < 1.0
      ? Math.max(0.18, 1.0 - this._lineAlpha * 0.82)
      : 0.18);

    layout.lines.forEach((line, lineIdx) => {
      const chars  = [...line];
      const totalW = ctx.measureText(line).width;
      let x        = layout.x - totalW / 2;
      const baseY  = layout.y + lineIdx * layout.lineHeight;

      chars.forEach((char, ci) => {
        const charW = ctx.measureText(char).width;
        const waveY = Math.sin(t * 2.8 + ci * 0.45 + lineIdx * 1.1) * amp;
        this._drawText(ctx, char, x, baseY + waveY, glowCSS, outlineCSS, state.bass, 'left');
        x += charW;
      });
    });
  }

  // ── Entrance: Typewriter ──────────────────────────────────────────────────

  _renderTypewriter(ctx, layout, glowCSS, outlineCSS, state) {
    ctx.textAlign = 'left';

    const totalChars  = layout.lines.reduce((s, l) => s + [...l].length, 0);
    // Allow slight overshoot so the last char fully appears
    const visibleF    = this._lineAlpha * (totalChars + 1.5);

    let charCount = 0;

    layout.lines.forEach((line, lineIdx) => {
      const chars  = [...line];
      const totalW = ctx.measureText(line).width;
      let x        = layout.x - totalW / 2;
      const baseY  = layout.y + lineIdx * layout.lineHeight;

      chars.forEach((char) => {
        const charW = ctx.measureText(char).width;

        if (charCount < visibleF) {
          // Partial alpha for the currently-typing character (smooth pop-in)
          const alpha = Math.min(1.0, visibleF - charCount);
          ctx.globalAlpha = alpha;

          // Flash glow on the "cursor" character (most recently revealed)
          const isCursor = Math.abs(visibleF - charCount - 0.5) < 1.0;
          const cursorGlow = isCursor ? this._boostGlow(glowCSS) : glowCSS;

          this._drawText(ctx, char, x, baseY, cursorGlow, outlineCSS, state.bass + (isCursor ? 0.4 : 0), 'left');
        }
        x += charW;
        charCount++;
      });
    });
  }

  // ── Core text draw (shared by all styles) ─────────────────────────────────

  _drawText(ctx, text, x, y, glowCSS, outlineCSS, bass, align) {
    const prevAlign = ctx.textAlign;
    if (align) ctx.textAlign = align;

    // Outline / stroke pass
    if (this.outlineWidth > 0) {
      ctx.save();
      ctx.strokeStyle = outlineCSS;
      ctx.lineWidth   = this.outlineWidth * 2.2;
      ctx.lineJoin    = 'round';
      ctx.shadowColor = outlineCSS;
      ctx.shadowBlur  = this.outlineWidth * 4;
      ctx.strokeText(text, x, y);
      ctx.restore();
    }

    // Glow shadow pass
    ctx.shadowColor = glowCSS;
    ctx.shadowBlur  = 3 + bass * 5;
    ctx.fillStyle   = '#ffffff';
    ctx.fillText(text, x, y);

    // Crisp fill (no shadow)
    ctx.shadowBlur  = 0;
    ctx.shadowColor = 'transparent';
    ctx.fillText(text, x, y);

    if (align) ctx.textAlign = prevAlign;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _easeOut(t) {
    return 1 - Math.pow(1 - t, 2);
  }

  _boostGlow(css) {
    // Make glow fully opaque for cursor flash
    return css.replace(/,[\d.]+\)$/, ',1.0)');
  }

  // ── 3D extrusion ──────────────────────────────────────────────────────────
  // Renders multiple offset copies of the text behind the main layer,
  // each slightly darker and more transparent, creating apparent depth/thickness.
  // The extrusion direction rotates slowly over time.

  _renderExtrusion(ctx, layout, moodColor) {
    const layers   = Math.min(10, Math.round(this.extrusionDepth));
    if (layers < 1) return;

    // Light source direction rotates slowly — creates dynamic 3D feel
    const angle = this._time * 0.16;
    const extX  =  Math.cos(angle) * 2.4;   // per-layer x offset
    const extY  =  Math.sin(angle) * 1.3;   // per-layer y offset (half for aspect ratio)

    // Base alpha tracks the line's current fade state
    const baseA = this._targetAlpha === 0
      ? Math.max(0, this._lineAlpha)
      : this._lineAlpha;

    ctx.textAlign  = 'center';
    ctx.shadowBlur = 0;

    for (let d = layers; d >= 1; d--) {
      const t  = d / layers;           // 1 = farthest back, 0 = nearest front
      const da = baseA * (1 - t * 0.72) * 0.82;
      if (da < 0.01) continue;

      ctx.globalAlpha = da;
      ctx.fillStyle   = this._rgbToCSS([
        Math.max(0, moodColor[0] * (1 - t * 0.55) + t * 0.04),
        Math.max(0, moodColor[1] * (1 - t * 0.55) + t * 0.04),
        Math.max(0, moodColor[2] * (1 - t * 0.55) + t * 0.04),
      ], 1);

      layout.lines.forEach((line, i) => {
        ctx.fillText(line,
          layout.x + extX * d,
          layout.y + i * layout.lineHeight + extY * d
        );
      });
    }

    // Reset so subsequent passes start clean
    ctx.globalAlpha = 1.0;
  }

  _rgbToCSS([r, g, b], a = 1) {
    return `rgba(${Math.round(r*255)},${Math.round(g*255)},${Math.round(b*255)},${a})`;
  }
}
