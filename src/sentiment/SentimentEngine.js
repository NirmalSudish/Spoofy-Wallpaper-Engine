/**
 * SentimentEngine
 * ---------------
 * Analyzes lyric lines using the AFINN-based Sentiment global
 * and maps results to visual parameters: color, distortion, speed, glow.
 *
 * Mood Bands:
 *   euphoric  (+5 to +∞)   → vivid purples/pinks, fast expansion, strong glow
 *   joyful    (+2 to +5)   → warm golds/yellows, bouncy motion, bright
 *   calm      (-1 to +2)   → cool blues/teals, slow waves, soft blur
 *   sad       (-4 to -1)   → desaturated blues/greys, heavy trails, slow
 *   intense   (-∞ to -4)   → hot reds/oranges, glitch, sharp distortion
 */
export class SentimentEngine {
  constructor() {
    this.currentMood   = 'calm';
    this.currentScore  = 0;
    this.currentNorm   = 0;

    // Smooth transition between mood states
    this._targetColor  = [0.4, 0.7, 1.0];
    this._currentColor = [0.4, 0.7, 1.0];
    this._colorSmooth  = 0.05;

    // Visual parameter targets
    this._targetParams = { ...this._moodParams('calm') };
    this._params       = { ...this._moodParams('calm') };
    this._paramSmooth  = 0.04;

    // Worker for heavy analysis (optional, falls back to sync)
    this._useSync = true;
  }

  /**
   * Analyze a lyric line synchronously.
   * @returns {{ score, normalized, mood, color, params }}
   */
  analyze(text) {
    if (typeof window.Sentiment === 'undefined') {
      return this._buildResult(0);
    }

    const result = window.Sentiment.analyze(text);
    const score  = result.score;

    return this._buildResult(score);
  }

  /** Called each frame to smoothly transition visual parameters */
  update() {
    // Interpolate color
    for (let i = 0; i < 3; i++) {
      this._currentColor[i] += (this._targetColor[i] - this._currentColor[i]) * this._colorSmooth;
    }
    // Interpolate params
    for (const key of Object.keys(this._params)) {
      this._params[key] += (this._targetParams[key] - this._params[key]) * this._paramSmooth;
    }
  }

  get smoothedColor()  { return [...this._currentColor]; }
  get smoothedParams() { return { ...this._params }; }

  /** Force a keyword-driven mood temporarily */
  overrideMood(mood) {
    this.currentMood = mood;
    this._targetColor = this._moodColor(mood);
    this._targetParams = this._moodParams(mood);
    return { mood, color: this._targetColor, params: this._targetParams };
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _buildResult(score) {
    this.currentScore = score;
    const normalized  = Math.max(-1, Math.min(1, score / 8));
    this.currentNorm  = normalized;

    const mood   = this._scorToMood(score);
    const color  = this._moodColor(mood);
    const params = this._moodParams(mood);

    this.currentMood = mood;

    // Set smooth targets
    this._targetColor  = color;
    this._targetParams = params;

    return { score, normalized, mood, color, params };
  }

  _scorToMood(score) {
    if (score >= 5)  return 'euphoric';
    if (score >= 2)  return 'joyful';
    if (score >= -1) return 'calm';
    if (score >= -4) return 'sad';
    return 'intense';
  }

  _moodColor(mood) {
    const palette = {
      euphoric: [0.95, 0.3,  0.85],   // vivid magenta-purple
      joyful:   [1.0,  0.85, 0.2],    // warm gold
      calm:     [0.3,  0.7,  1.0],    // cool sky blue
      sad:      [0.4,  0.45, 0.7],    // muted indigo
      intense:  [1.0,  0.2,  0.1],    // hot red
      
      // Keyword trigger overrides:
      fire:     [1.0,  0.4,  0.0],    // intense orange
      water:    [0.1,  0.6,  0.9],    // deep ocean cyan
      space:    [0.6,  0.1,  1.0],    // deep space purple
      glitch:   [0.1,  1.0,  0.5],    // matrix green
      pulse:    [0.9,  0.1,  0.2],    // deep crimson
    };
    return palette[mood] || palette.calm;
  }

  _moodParams(mood) {
    /**
     * distortion  — UV displacement strength
     * noiseFreq   — noise sampling frequency
     * noiseSpeed  — animation time multiplier
     * feedbackDecay — how much ghost trail persists (0=none, 1=full)
     * glowStrength  — bloom intensity
     * rgbShift    — chromatic aberration amount
     * textScale   — text size multiplier
     * animSpeed   — overall timing speed
     */
    const table = {
      euphoric: { distortion: 0.005, noiseFreq: 3.5, noiseSpeed: 1.4, feedbackDecay: 0.70, glowStrength: 0.8, rgbShift: 0.001, textScale: 1.08, animSpeed: 1.5 },
      joyful:   { distortion: 0.004, noiseFreq: 2.5, noiseSpeed: 1.0, feedbackDecay: 0.75, glowStrength: 0.6, rgbShift: 0.001, textScale: 1.04, animSpeed: 1.1 },
      calm:     { distortion: 0.002, noiseFreq: 1.8, noiseSpeed: 0.5, feedbackDecay: 0.82, glowStrength: 0.4, rgbShift: 0.000, textScale: 1.00, animSpeed: 0.7 },
      sad:      { distortion: 0.003, noiseFreq: 1.4, noiseSpeed: 0.3, feedbackDecay: 0.85, glowStrength: 0.3, rgbShift: 0.000, textScale: 0.96, animSpeed: 0.5 },
      intense:  { distortion: 0.008, noiseFreq: 5.0, noiseSpeed: 2.0, feedbackDecay: 0.65, glowStrength: 1.0, rgbShift: 0.002, textScale: 1.12, animSpeed: 2.0 },
      
      // Keyword overrides:
      fire:     { distortion: 0.008, noiseFreq: 3.0, noiseSpeed: 2.5, feedbackDecay: 0.70, glowStrength: 0.9, rgbShift: 0.001, textScale: 1.06, animSpeed: 1.8 },
      water:    { distortion: 0.006, noiseFreq: 1.2, noiseSpeed: 0.8, feedbackDecay: 0.78, glowStrength: 0.5, rgbShift: 0.001, textScale: 1.00, animSpeed: 0.8 },
      space:    { distortion: 0.001, noiseFreq: 1.0, noiseSpeed: 0.2, feedbackDecay: 0.86, glowStrength: 0.8, rgbShift: 0.000, textScale: 1.02, animSpeed: 0.5 },
      glitch:   { distortion: 0.012, noiseFreq: 8.0, noiseSpeed: 4.0, feedbackDecay: 0.60, glowStrength: 0.7, rgbShift: 0.004, textScale: 1.10, animSpeed: 2.5 },
      pulse:    { distortion: 0.003, noiseFreq: 2.0, noiseSpeed: 1.2, feedbackDecay: 0.78, glowStrength: 0.7, rgbShift: 0.001, textScale: 1.05, animSpeed: 1.2 },
    };
    return table[mood] || table.calm;
  }
}
