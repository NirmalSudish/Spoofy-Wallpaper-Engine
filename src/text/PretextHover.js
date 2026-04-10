/**
 * PretextHover
 * ------------
 * Per-character spring physics hover effect.
 * Each character has an origin (rest) position and is pushed away from
 * the cursor when the mouse gets close, then springs back elastically.
 *
 * No external library required — pure Canvas2D measurement + physics.
 */

const OFF = -9999;

export class PretextHover {
  constructor() {
    this.enabled = true;

    // Raw mouse position (set from main.js)
    this._rawMx = OFF;
    this._rawMy = OFF;

    // Smoothed mouse position
    this._mx = OFF;
    this._my = OFF;

    // Per-character spring state
    // Each entry: { char, ox, oy, x, y, vx, vy, w, hoverGlow }
    this._chars    = [];
    this._lastKey  = '';

    // ── Physics knobs ──────────────────────────────────────────────────────
    this.influenceRadius = 90;   // px: how far the cursor reaches
    this.repulsion       = 5;    // push force — gentle nudge, not a scatter
    this.springK         = 0.18; // snappy spring return
    this.damping         = 0.65; // high damping = letters settle quickly
    this.cursorSmooth    = 0.18; // mouse smoothing factor
  }

  /** Called from main.js mousemove */
  setMouse(x, y) {
    this._rawMx = x;
    this._rawMy = y;
  }

  /** Reset when a new lyric line is set */
  reset() {
    this._chars   = [];
    this._lastKey = '';
  }

  /**
   * Compute this frame's character positions.
   * Returns array of { text, x, y, align:'left', hoverGlow }
   */
  update(layout, ctx) {
    // Smooth cursor
    if (this._rawMx === OFF) {
      this._mx = OFF;
      this._my = OFF;
    } else {
      const s  = this.cursorSmooth;
      this._mx += (this._rawMx - this._mx) * s;
      this._my += (this._rawMy - this._my) * s;
    }

    const lineKey = layout.lines.join('\x00') + '|' + layout.font;
    if (lineKey !== this._lastKey) {
      this._lastKey = lineKey;
      this._buildChars(layout, ctx);
    }

    ctx.font = layout.font;

    const mx = this._mx;
    const my = this._my;
    const R  = this.influenceRadius;
    const R2 = R * R;

    this._chars.forEach(c => {
      // Spring toward origin
      c.vx += (c.ox - c.x) * this.springK;
      c.vy += (c.oy - c.y) * this.springK;

      // Cursor repulsion — push from char center
      const cx  = c.ox + c.w * 0.5;
      const cy  = c.oy;
      const dx  = cx - mx;
      const dy  = cy - my;
      const d2  = dx * dx + dy * dy;

      c.hoverGlow = 0;

      if (d2 < R2 && d2 > 0.25) {
        const dist = Math.sqrt(d2);
        const t    = 1 - dist / R;          // 0 at edge, 1 at center
        const f    = t * t * this.repulsion;
        c.vx += (dx / dist) * f;
        c.vy += (dy / dist) * f;
        c.hoverGlow = t;
      }

      // Damp and integrate
      c.vx *= this.damping;
      c.vy *= this.damping;
      c.x  += c.vx;
      c.y  += c.vy;
    });

    // Return as render chunks (one per character)
    return this._chars.map(c => ({
      text:      c.char,
      x:         c.x,
      y:         c.y,
      align:     'left',
      hoverGlow: c.hoverGlow,
    }));
  }

  /** Build per-character rest positions from the layout */
  _buildChars(layout, ctx) {
    ctx.font = layout.font;
    this._chars = [];

    layout.lines.forEach((line, li) => {
      const chars  = [...line];
      const totalW = ctx.measureText(line).width;
      let x        = layout.x - totalW / 2;
      const baseY  = layout.y + li * layout.lineHeight;

      chars.forEach(char => {
        const w = ctx.measureText(char).width;
        this._chars.push({
          char,
          ox: x,  oy: baseY,
          x:  x,  y:  baseY,
          vx: 0,  vy: 0,
          w,
          hoverGlow: 0,
        });
        x += w;
      });
    });
  }

  get ready() { return true; }
}
