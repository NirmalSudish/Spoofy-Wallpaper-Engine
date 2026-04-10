/**
 * main.js — LyricsVisualizer Orchestrator
 * ----------------------------------------
 * Ties every subsystem together:
 *   Bridge → SentimentEngine → KeywordTriggers → TextCanvas → GLRenderer
 *
 * Render loop (rAF, ~60fps):
 *   1. SentimentEngine.update()   — smooth-lerp mood params each frame
 *   2. TextCanvas.render()        — draw lyric to offscreen canvas
 *   3. GLRenderer.render()        — WebGL composite + feedback + effects
 *   4. Debug overlay (if enabled)
 */

import { WebNowPlayingBridge } from './bridge/WebNowPlaying.js';
import { AudioReactivity }     from './audio/AudioReactivity.js';
import { TextCanvas }          from './renderer/TextCanvas.js';
import { GLRenderer }          from './renderer/GLRenderer.js';
import { SentimentEngine }     from './sentiment/SentimentEngine.js';
import { KeywordTriggers }     from './keywords/KeywordTriggers.js';

class LyricsVisualizer {
  constructor() {
    // ── DOM ──────────────────────────────────────────────────────────────
    this.glCanvas        = document.getElementById('glCanvas');
    this.textCanvas      = document.getElementById('textCanvas');
    this.hudTrack        = document.getElementById('hud-track');
    this.hudArtist       = document.getElementById('hud-artist');
    this.hudProgressBar  = document.getElementById('hud-progress-bar');
    this.hudVisualizer   = document.getElementById('hud-visualizer');
    this.hudAlbumArt     = document.getElementById('hud-album-art');
    this._vizCtx         = null;   // set in init()

    // ── Shared live state ─────────────────────────────────────────────────
    this.state = {
      // Audio bands (smoothed, 0–1)
      bass:  0, mid: 0, high: 0, overall: 0,
      // Sentiment
      sentiment: 0,
      moodColor: [0.4, 0.7, 1.0],
      moodName:  'calm',
      params:    null,
      // Keyword triggers
      glitch:    0,
      // Track meta
      track: '', artist: '',
      // Effect state (batch 1)
      beatPulse:     0,
      scanlines:     0,
      rainbow:       0,
      outerGlowMult: 1.0,
      // Effect state (batch 2 — new)
      refraction:    0,
      caustics:      0,
      perspTilt:     0,
      iridescence:   0,
      godRays:       0,
    };

    // ── Subsystems ────────────────────────────────────────────────────────
    this.sentimentEngine  = new SentimentEngine();
    this.keywordTriggers  = new KeywordTriggers();
    this.audioReactivity  = new AudioReactivity();
    this.textCanvasRender = new TextCanvas(this.textCanvas);
    this.glRenderer       = new GLRenderer(this.glCanvas);
    this.bridge           = new WebNowPlayingBridge({
      demo: false,
    });

    // ── Beat pulse tracking ───────────────────────────────────────────────
    this._weBeatPulseEnabled = false;
    this._beatFired          = false;

    // ── Mouse tracking for Pretext hover ─────────────────────────────────
    window.addEventListener('mousemove', (e) => {
      this.textCanvasRender.hover.setMouse(e.clientX, e.clientY);
    });
    window.addEventListener('mouseleave', () => {
      this.textCanvasRender.hover.setMouse(-9999, -9999);
    });

    // ── Debug ─────────────────────────────────────────────────────────────
    this._debug = new URLSearchParams(location.search).has('debug');
    this._debugEl = null;
    this._frameCount = 0;
    this._lastFPSTime = performance.now();
    this._fps = 60;
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  async init() {
    // WebGL
    try {
      await this.glRenderer.init();
    } catch (err) {
      console.error('[Main] WebGL init failed:', err);
      return;
    }

    // Text canvas
    this.textCanvasRender.init();

    // Visualizer canvas — fixed pixel size, CSS scales it
    if (this.hudVisualizer) {
      this.hudVisualizer.width  = 600;
      this.hudVisualizer.height = 90;
      this._vizCtx = this.hudVisualizer.getContext('2d');
    }

    // Sizing
    this._resize();
    window.addEventListener('resize', () => this._resize());

    // Audio
    this.audioReactivity.init((bass, mid, high, overall) => {
      this.state.bass    = bass;
      this.state.mid     = mid;
      this.state.high    = high;
      this.state.overall = overall;
    });

    // Bridge callbacks
    this.bridge.onLyricLine  ((line)                       => this._handleLine(line));
    this.bridge.onTrackChange((title, artist, coverUrl)    => this._handleTrack(title, artist, coverUrl));
    this.bridge.onPlayStateChange((playing)                => this._setPlayIcon(playing));
    this.bridge.onConnectionChange((connected) => {
      console.log('[Main] WNP connection:', connected ? 'UP' : 'DOWN');
    });
    this.bridge.connect();

    // Playback controls
    this._initControls();

    // Debug overlay
    if (this._debug) this._initDebug();

    // Wallpaper Engine property listener (user config via WE sidebar)
    // WE calls this on load and whenever the user changes a property.
    // Must always be set unconditionally.
    window.wallpaperPropertyListener = {
      applyUserProperties: (props) => this._applyWEProps(props),
    };
    this._weColorScheme   = null; // null = auto
    this._weDecayOverride = null;
    this._weGlowOverride  = null;
    this._weDistortOverride = null;

    // Start render loop
    this._loop();

    console.log('[Main] LyricsVisualizer ready ✓');
  }

  // ── Event handlers ────────────────────────────────────────────────────────

  _handleLine(line) {
    // 1. Sentiment analysis
    const result = this.sentimentEngine.analyze(line);

    // 2. Keyword triggers
    const kw = this.keywordTriggers.check(line);
    
    // Apply immediate keyword color/param overrides
    if (kw.colorMode) {
      const overrides = this.sentimentEngine.overrideMood(kw.colorMode);
      result.mood   = overrides.mood;
      result.color  = overrides.color;
      result.params = overrides.params;
    }

    this.state.sentiment = result.normalized;
    this.state.moodColor = this.sentimentEngine.smoothedColor;
    this.state.moodName  = result.mood;
    this.state.params    = result.params;

    if (kw.glitch)       this.state.glitch = Math.max(this.state.glitch, kw.glitch);
    
    // Additional parameter boosting specifically based on keyword triggers
    if (kw.heatDistort)  this.state.params = { ...this.state.params, distortion: Math.max(0.015, this.state.params.distortion), noiseSpeed: 2.5 };
    if (kw.waterRipple)  this.state.params = { ...this.state.params, noiseFreq: 1.2, distortion: Math.max(0.012, this.state.params.distortion) };
    if (kw.bloom)        this.state.params = { ...this.state.params, glowStrength: Math.max(kw.bloom * 0.75, this.state.params.glowStrength) };

    // 3. Feed to text canvas renderer
    this.textCanvasRender.setLine(line, result);
  }

  _handleTrack(title, artist, coverUrl) {
    this.state.track  = title;
    this.state.artist = artist;

    // Clear the lyric canvas immediately so old lyrics don't linger on the new song
    this.textCanvasRender.setLine('', null);

    // Animate HUD
    this._animateHUD(title, artist);

    // Update album art — load via local proxy to avoid Wallpaper Engine CORS block
    if (this.hudAlbumArt) {
      this.hudAlbumArt.classList.remove('loaded');
      if (coverUrl) {
        const proxy = 'http://127.0.0.1:8889/art?url=' + encodeURIComponent(coverUrl);
        this.hudAlbumArt.onload  = () => this.hudAlbumArt.classList.add('loaded');
        this.hudAlbumArt.onerror = () => { /* stay hidden if unavailable */ };
        this.hudAlbumArt.src = proxy;
      } else {
        this.hudAlbumArt.src = '';
      }
    }
  }

  // ── Resize ────────────────────────────────────────────────────────────────

  _resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.glCanvas.width    = w;   this.glCanvas.height   = h;
    this.textCanvas.width  = w;   this.textCanvas.height = h;
    this.glRenderer.resize(w, h);
    this.textCanvasRender.resize(w, h);
  }

  // ── Render loop ───────────────────────────────────────────────────────────

  _loop() {
    requestAnimationFrame(() => this._loop());

    // 1. Smooth mood params each frame
    this.sentimentEngine.update();
    this.state.moodColor = this.sentimentEngine.smoothedColor;
    this.state.params    = { ...this.sentimentEngine.smoothedParams };

    // 2. Apply WE property overrides on top of mood params
    if (this._weColorScheme) {
      // Lock color to user-chosen scheme
      this.state.moodColor = this.sentimentEngine._moodColor(this._weColorScheme);
    }
    if (this._weDecayOverride !== null) {
      this.state.params.feedbackDecay = this._weDecayOverride;
    }
    if (this._weGlowOverride !== null) {
      this.state.params.glowStrength = this._weGlowOverride;
    }
    if (this._weDistortOverride !== null) {
      this.state.params.distortion = this._weDistortOverride;
    }

    // 3. Decay transient effects
    this.state.glitch *= 0.93;   // fade glitch over ~20 frames

    // 3b. Beat pulse — fire on strong bass transient, decay ring outward
    if (this._weBeatPulseEnabled) {
      if (this.state.bass > 0.52 && !this._beatFired) {
        this.state.beatPulse = 1.0;
        this._beatFired = true;
      }
      if (this.state.bass < 0.32) this._beatFired = false;
      this.state.beatPulse = Math.max(0, this.state.beatPulse * 0.96);
    }

    // 4. Text → offscreen canvas
    this.textCanvasRender.render(this.state);

    // 5. WebGL composite
    this.glRenderer.render({
      textCanvas: this.textCanvas,
      ...this.state,
    });

    // 6. Progress bar
    this._updateProgress();

    // 7. Visualizer
    this._drawVisualizer();

    // 8. Debug
    if (this._debug) this._updateDebug();
  }

  // ── Playback controls ─────────────────────────────────────────────────────

  _initControls() {
    const CTRL = 'http://127.0.0.1:8889';
    const send  = (path) => fetch(CTRL + path, { method: 'POST' }).catch(() => {});

    const btnPlay = document.getElementById('btn-play');
    const btnPrev = document.getElementById('btn-prev');
    const btnNext = document.getElementById('btn-next');

    if (!btnPlay) return;

    // Determine current play state from bridge on first click if unknown
    btnPlay.addEventListener('click', () => {
      const playing = this.bridge._track.isPlaying;
      send(playing ? '/pause' : '/play');
      // Optimistic icon flip — the bridge callback will confirm
      this._setPlayIcon(!playing);
      this.bridge._track.isPlaying = !playing;
    });

    const clearForSkip = () => {
      // Instantly wipe the display so the UI feels responsive before the API confirms
      this.textCanvasRender.setLine('', null);
      this._animateHUD('', '');
      if (this.hudAlbumArt) this.hudAlbumArt.classList.remove('loaded');
    };

    btnPrev?.addEventListener('click', () => { send('/prev'); clearForSkip(); });
    btnNext?.addEventListener('click', () => { send('/next'); clearForSkip(); });

    // Update button glow color each frame via CSS variable set in _drawVisualizer
    this._btnPlay = btnPlay;
  }

  _setPlayIcon(isPlaying) {
    const pause = document.getElementById('icon-pause');
    const play  = document.getElementById('icon-play');
    if (!pause || !play) return;
    pause.style.display = isPlaying  ? '' : 'none';
    play.style.display  = !isPlaying ? '' : 'none';
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _animateHUD(title, artist) {
    const el = this.hudTrack;
    const ar = this.hudArtist;
    // Fade-out then swap
    el.style.opacity = '0';
    ar.style.opacity = '0';
    setTimeout(() => {
      el.textContent   = title;
      ar.textContent   = artist;
      el.style.transition = 'opacity 0.8s ease';
      ar.style.transition = 'opacity 0.8s ease';
      el.style.opacity = '1';
      ar.style.opacity = '1';
    }, 400);
  }

  _updateProgress() {
    const bar  = this.hudProgressBar;
    if (!bar) return;
    const pos  = this.bridge._track.position  || 0;
    const dur  = this.bridge._track.duration  || 0;
    const pct  = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;
    bar.style.width = pct + '%';
    // Tint the bar with the current mood color
    const [r, g, b] = this.state.moodColor;
    bar.style.background = `rgba(${Math.round(r*255)},${Math.round(g*255)},${Math.round(b*255)},0.7)`;
  }

  _applyWEProps(props) {
    // Debug toggle
    if (props.showdebug !== undefined) {
      this._debug = !!props.showdebug.value;
      if (this._debug && !this._debugEl) this._initDebug();
    }

    // Demo mode toggle
    if (props.demomode !== undefined) {
      // If demo mode flipped on, we poke the bridge to start demo
      this.bridge._demoMode = !!props.demomode.value;
      if (this.bridge._demoMode && !this.bridge._connected) this.bridge._startDemoMode();
    }

    // Feedback decay override
    if (props.feedbackdecay !== undefined) {
      this._weDecayOverride = parseFloat(props.feedbackdecay.value);
    }

    // Glow strength override
    if (props.glowstrength !== undefined) {
      this._weGlowOverride = parseFloat(props.glowstrength.value);
    }

    // Base font size
    if (props.basefontsize !== undefined) {
      this.textCanvasRender.engine.baseFontSize = parseInt(props.basefontsize.value, 10);
    }

    // Distortion amount
    if (props.distortionamount !== undefined) {
      this._weDistortOverride = parseFloat(props.distortionamount.value);
    }

    // Color scheme override
    if (props.schemeid !== undefined && props.schemeid.value !== 'auto') {
      this._weColorScheme = props.schemeid.value;
    } else if (props.schemeid !== undefined) {
      this._weColorScheme = null;
    }

    // ── New effect properties ─────────────────────────────────────────────

    // Text entrance style
    if (props.entrancestyle !== undefined) {
      this.textCanvasRender.entranceStyle = props.entrancestyle.value;
    }

    // Text outline width
    if (props.outlinewidth !== undefined) {
      this.textCanvasRender.outlineWidth = parseFloat(props.outlinewidth.value);
    }

    // Wave amplitude
    if (props.waveamplitude !== undefined) {
      this.textCanvasRender.waveAmplitude = parseFloat(props.waveamplitude.value);
    }

    // Beat pulse rings
    if (props.beatpulse !== undefined) {
      this._weBeatPulseEnabled = !!props.beatpulse.value;
      if (!this._weBeatPulseEnabled) this.state.beatPulse = 0;
    }

    // Outer aura glow multiplier
    if (props.outerglow !== undefined) {
      this.state.outerGlowMult = parseFloat(props.outerglow.value);
    }

    // CRT scanlines
    if (props.scanlineintensity !== undefined) {
      this.state.scanlines = parseFloat(props.scanlineintensity.value);
    }

    // Rainbow / prismatic text
    if (props.rainbowintensity !== undefined) {
      this.state.rainbow = parseFloat(props.rainbowintensity.value);
    }

    // ── New motion/3D effects ─────────────────────────────────────────────

    if (props.refractionstrength !== undefined)
      this.state.refraction  = parseFloat(props.refractionstrength.value);

    if (props.causticsintensity !== undefined)
      this.state.caustics    = parseFloat(props.causticsintensity.value);

    if (props.persptilt !== undefined)
      this.state.perspTilt   = parseFloat(props.persptilt.value);

    if (props.iridescence !== undefined)
      this.state.iridescence = parseFloat(props.iridescence.value);

    if (props.godrays !== undefined)
      this.state.godRays     = parseFloat(props.godrays.value);

    if (props.extrusiondepth !== undefined)
      this.textCanvasRender.extrusionDepth = parseFloat(props.extrusiondepth.value);

    // Pretext hover effect
    if (props.hovereffect !== undefined) {
      this.textCanvasRender.hover.enabled = !!props.hovereffect.value;
    }
    if (props.hoverradius !== undefined) {
      const r = parseFloat(props.hoverradius.value);
      this.textCanvasRender.hover.exclusionRadius = r;
      this.textCanvasRender.hover.verticalRadius  = r * 0.65;
    }
  }

  // ── Visualizer ────────────────────────────────────────────────────────────

  _drawVisualizer() {
    const ctx = this._vizCtx;
    if (!ctx) return;

    const W = 600, H = 90;
    ctx.clearRect(0, 0, W, H);

    // vizBins from AudioReactivity
    const bins  = this.audioReactivity.vizBins;
    const TOTAL = 128;
    const BAR_N = 48;
    const gap   = 2.5;
    const barW  = W / BAR_N;
    const [r, g, b] = this.state.moodColor;

    const ri = Math.round(r * 255);
    const gi = Math.round(g * 255);
    const bi = Math.round(b * 255);
    const tr = Math.min(255, Math.round((r + 0.5) * 255));
    const tg = Math.min(255, Math.round((g + 0.5) * 255));
    const tb = Math.min(255, Math.round((b + 0.6) * 255));

    // Log-scale mapping: each bar covers a log-spaced slice of the 64 bins
    // so bass, mids, and treble all occupy equal visual width.
    const logMin = Math.log(1);
    const logMax = Math.log(TOTAL + 1);

    for (let i = 0; i < BAR_N; i++) {
      const lo    = Math.floor(Math.exp(logMin + (logMax - logMin) * (i       / BAR_N))) - 1;
      const hi    = Math.floor(Math.exp(logMin + (logMax - logMin) * ((i + 1) / BAR_N))) - 1;
      const binLo = Math.max(0, Math.min(TOTAL - 1, lo));
      const binHi = Math.max(0, Math.min(TOTAL - 1, hi));

      let val = 0, count = binHi - binLo + 1;
      for (let k = binLo; k <= binHi; k++) val += bins[k];
      val /= count;

      // bins are already normalized — just clamp
      val = Math.min(1, Math.max(0, val));

      const barH = Math.max(2, val * (H - 6));
      const x    = i * barW + gap * 0.5;
      const w    = barW - gap;
      const y    = H - barH;

      const grad = ctx.createLinearGradient(0, y, 0, H);
      grad.addColorStop(0,   `rgba(${tr},${tg},${tb},0.85)`);
      grad.addColorStop(0.5, `rgba(${ri},${gi},${bi},0.55)`);
      grad.addColorStop(1,   `rgba(${ri},${gi},${bi},0.10)`);

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(x, y, w, barH, [2, 2, 0, 0]);
      ctx.fill();

      // Bright cap on taller bars
      if (barH > 10) {
        ctx.fillStyle = `rgba(${tr},${tg},${tb},0.70)`;
        ctx.fillRect(x, y, w, 2);
      }
    }

    // Update album art glow to match current mood color
    if (this.hudAlbumArt) {
      this.hudAlbumArt.style.boxShadow =
        `0 0 32px rgba(${ri},${gi},${bi},0.5), 0 4px 20px rgba(0,0,0,0.6)`;
    }

    // Tint play/pause button border with mood color
    if (this._btnPlay) {
      this._btnPlay.style.borderColor  = `rgba(${ri},${gi},${bi},0.40)`;
      this._btnPlay.style.background   = `rgba(${ri},${gi},${bi},0.08)`;
    }
  }

  // ── Debug overlay ─────────────────────────────────────────────────────────

  _initDebug() {
    const el = document.createElement('div');
    el.id = 'debug-overlay';
    el.classList.add('visible');
    document.body.appendChild(el);
    this._debugEl = el;
  }

  _updateDebug() {
    if (!this._debugEl) return;
    this._frameCount++;
    const now = performance.now();
    if (now - this._lastFPSTime >= 500) {
      this._fps = Math.round(this._frameCount / ((now - this._lastFPSTime) / 1000));
      this._frameCount  = 0;
      this._lastFPSTime = now;
    }

    const s = this.state;
    this._debugEl.innerHTML = `
      FPS <span>${this._fps}</span><br>
      Mood <span>${s.moodName}</span><br>
      Sentiment <span>${s.sentiment.toFixed(3)}</span><br>
      Bass <span>${s.bass.toFixed(3)}</span>
      Mid <span>${s.mid.toFixed(3)}</span>
      High <span>${s.high.toFixed(3)}</span><br>
      Glitch <span>${s.glitch.toFixed(3)}</span><br>
      Track <span>${s.track || '—'}</span>
    `;
  }
}

// ── Bootstrap ──────────────────────────────────────────────────────────────
window.addEventListener('load', () => {
  const app = new LyricsVisualizer();
  app.init().catch(console.error);
  window.__visualizer = app; // expose for console debugging
});
