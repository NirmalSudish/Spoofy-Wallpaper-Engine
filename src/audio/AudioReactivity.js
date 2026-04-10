/**
 * AudioReactivity
 * ---------------
 * Hooks into window.wallpaperAudioListener (Wallpaper Engine Web API).
 * Splits the 128-sample audio array into bass / mid / high frequency bands.
 * Applies smoothing so visuals don't jitter on transients.
 *
 * Falls back to a sine-wave simulation when running outside WE.
 */
export class AudioReactivity {
  constructor() {
    this.bass    = 0;
    this.mid     = 0;
    this.high    = 0;
    this.overall = 0;
    this._globalPeak = 0.001;

    // Smoothing factor (0 = instant, 1 = no change)
    this.smoothing = 0.75;

    this._raw    = new Float32Array(128).fill(0);
    this.rawBins = new Float32Array(128).fill(0); // band-smoothed bins (public)
    this.vizBins = new Float32Array(128).fill(0); // fast-smoothed bins for visualizer (public)
    this._cb  = null;
    this._simTimer = null;

    // Band slice indices (128 samples total, Nyquist split)
    this.BANDS = {
      bass:   [0,   15],
      mid:    [16,  55],
      high:   [56,  127],
    };
  }

  /**
   * @param {Function} callback - (bass, mid, high, overall) called each audio frame
   */
  init(callback) {
    this._cb = callback;

    if (typeof window.wallpaperRegisterAudioListener === 'function') {
      window.wallpaperRegisterAudioListener((audioArray) => {
        this._process(audioArray);
      });
      console.log('[Audio] Wallpaper Engine audio listener registered.');
    } else {
      console.warn('[Audio] WE audio API not found, using simulation.');
      this._simulate();
    }
  }

  _process(audioArray) {
    let frameMax = 0;
    for (let i = 0; i < 128; i++) {
      if (audioArray[i] > frameMax) frameMax = audioArray[i];
    }
    // Track the loudest volume recently to normalize against system volume changes
    this._globalPeak = Math.max(0.008, Math.max(frameMax, this._globalPeak * 0.995));

    const bandAvg = (lo, hi) => {
      let sum = 0;
      for (let i = lo; i <= hi; i++) sum += audioArray[i];
      return (sum / (hi - lo + 1)) / this._globalPeak;
    };

    const rawBass  = bandAvg(...this.BANDS.bass);
    const rawMid   = bandAvg(...this.BANDS.mid);
    const rawHigh  = bandAvg(...this.BANDS.high);

    // Smooth with lerp
    const s = this.smoothing;
    this.bass    = this.bass    * s + rawBass  * (1 - s);
    this.mid     = this.mid     * s + rawMid   * (1 - s);
    this.high    = this.high    * s + rawHigh  * (1 - s);
    this.overall = (this.bass + this.mid + this.high) / 3;

    // Band-smoothed bins (slow, used by WebGL)
    for (let i = 0; i < 128; i++) {
      const v = audioArray[i] / this._globalPeak;
      this.rawBins[i] = this.rawBins[i] * s + v * (1 - s);
    }
    // Fast-smoothed bins for the visualizer — reacts much quicker to transients
    const vs = 0.40;
    for (let i = 0; i < 128; i++) {
      const v = audioArray[i] / this._globalPeak;
      // Attack fast, decay a touch slower so bars don't flicker
      const decay = v < this.vizBins[i] ? 0.55 : vs;
      this.vizBins[i] = this.vizBins[i] * decay + v * (1 - decay);
    }

    this._cb && this._cb(this.bass, this.mid, this.high, this.overall);
  }

  /** Simulate audio reactivity using oscillating sine waves (for dev/demo) */
  _simulate() {
    let t = 0;
    const tick = () => {
      t += 0.016; // ~60fps
      const bass  = (Math.sin(t * 1.1)  * 0.5 + 0.5) * 0.6;
      const mid   = (Math.sin(t * 2.3 + 1.0) * 0.5 + 0.5) * 0.3;
      const high  = (Math.sin(t * 4.7 + 2.1) * 0.5 + 0.5) * 0.2;

      const s = this.smoothing;
      this.bass  = this.bass  * s + bass  * (1 - s);
      this.mid   = this.mid   * s + mid   * (1 - s);
      this.high  = this.high  * s + high  * (1 - s);
      this.overall = (this.bass + this.mid + this.high) / 3;

      // Simulate per-bin values across 128 bins
      for (let i = 0; i < 128; i++) {
        const norm = i / 127;
        const raw = (
          bass  * Math.exp(-norm * 5.0) +
          mid   * Math.exp(-Math.pow(norm - 0.35, 2) * 18) +
          high  * Math.exp(-Math.pow(norm - 0.75, 2) * 22)
        ) * (0.7 + 0.3 * Math.sin(t * 6 + i * 0.4));
        const v = Math.max(0, raw);
        this.rawBins[i] = this.rawBins[i] * s + v * (1 - s);
        const decay = v < this.vizBins[i] ? 0.55 : 0.40;
        this.vizBins[i] = this.vizBins[i] * decay + v * (1 - decay);
      }

      this._cb && this._cb(this.bass, this.mid, this.high, this.overall);
      this._simTimer = requestAnimationFrame(tick);
    };
    tick();
  }

  destroy() {
    if (this._simTimer) cancelAnimationFrame(this._simTimer);
  }
}
