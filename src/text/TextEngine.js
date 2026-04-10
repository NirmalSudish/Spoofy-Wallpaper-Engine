/**
 * TextEngine
 * ----------
 * Pretext-style layout engine.
 * Pre-calculates font metrics and line wrapping on an offscreen canvas
 * so the render stage can position text instantly without layout reflows.
 *
 * Features:
 *  - Word-wrap with max-width constraint
 *  - Precise centered layout with exact bounding boxes
 *  - Font weight / style interpolation per mood
 *  - Character-level metric cache
 */
export class TextEngine {
  constructor() {
    // Measurement canvas (tiny, never rendered to screen)
    this._mc  = document.createElement('canvas');
    this._mc.width  = 4;
    this._mc.height = 4;
    this._ctx = this._mc.getContext('2d');

    this._cache   = new Map();   // string → LayoutResult
    this._maxAge  = 200;         // max cache entries

    // Default style
    this.fontFamily = "'Outfit', 'Inter', sans-serif";
    this.baseFontSize = 42;      // px, at 1920×1080 reference
  }

  /**
   * Compute layout for a lyric line.
   * @param {string}  text
   * @param {number}  canvasW    - rendering canvas width
   * @param {number}  canvasH    - rendering canvas height
   * @param {Object}  moodParams - { textScale, mood }
   * @returns {LayoutResult}
   */
  layout(text, canvasW, canvasH, moodParams = {}) {
    const scale     = moodParams.textScale || 1.0;
    const mood      = moodParams.mood      || 'calm';
    const fontSize  = Math.round(this._responsiveFontSize(canvasW) * scale);
    const maxWidth  = canvasW * 0.84;
    const cacheKey  = `${text}|${fontSize}|${maxWidth}`;

    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);

    const { weight, style } = this._fontStyleForMood(mood);
    const font = `${style} ${weight} ${fontSize}px ${this.fontFamily}`;
    this._ctx.font = font;

    const lines  = this._wrap(text, maxWidth);
    const lineH  = fontSize * 1.25;
    const totalH = lines.length * lineH;

    const result = {
      lines,
      font,
      fontSize,
      lineHeight: lineH,
      totalHeight: totalH,
      // Center position in canvas
      x: canvasW / 2,
      y: canvasH / 2 - totalH / 2 + lineH * 0.85,
      // Per-line metrics
      metrics: lines.map(l => ({ width: this._ctx.measureText(l).width })),
    };

    // Store in cache
    this._cache.set(cacheKey, result);
    if (this._cache.size > this._maxAge) {
      this._cache.delete(this._cache.keys().next().value);
    }

    return result;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  _responsiveFontSize(canvasW) {
    // Scale base size from 1920 reference, capped to avoid extreme sizes
    const scale = Math.min(canvasW / 1920, 1.6);
    return Math.round(this.baseFontSize * scale);
  }

  _fontStyleForMood(mood) {
    const table = {
      euphoric: { weight: '700', style: 'italic'  },
      joyful:   { weight: '700', style: 'normal'  },
      calm:     { weight: '300', style: 'normal'  },
      sad:      { weight: '200', style: 'italic'  },
      intense:  { weight: '700', style: 'normal'  },
    };
    return table[mood] || table.calm;
  }

  _wrap(text, maxWidth) {
    const words = text.split(' ');
    const lines = [];
    let current = '';

    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      if (this._ctx.measureText(test).width > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
    return lines;
  }
}
