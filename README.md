# 🎵 Spotify Lyrics Visualizer — Wallpaper Engine

A high-performance WebGL web wallpaper that renders Spotify lyrics with **TouchDesigner-style visual effects**, driven by music semantics and real-time audio.

---

## ✨ Features

| System | Details |
|--------|---------|
| **Lyric Sync** | WebNowPlaying-Redux WebSocket → lrclib.net timestamped LRC |
| **Sentiment Engine** | AFINN-165 analysis → 5 mood states → live visual mapping |
| **GLSL Effects** | Simplex noise displacement, RGB chromatic aberration, FBM distortion |
| **Feedback Loop** | Ping-pong FBO (TD Feedback TOP simulation) — ghost trails, motion persistence |
| **Glow / Bloom** | 8-tap radial gather on text alpha → mood-tinted glow |
| **Keyword Triggers** | "fire", "rain", "space", "glitch" → one-shot effect bursts |
| **Audio Reactivity** | Wallpaper Engine `wallpaperRegisterAudioListener` → bass/mid/high bands |
| **Text Engine** | Pretext-style offscreen layout — no DOM reflows at runtime |
| **HUD** | Subtle bottom-center track/artist display |
| **Debug Overlay** | Add `?debug` to URL to see FPS, mood, audio levels |

---

## 🗂 Project Structure

```
wallpaperengine-wallpaper/
├── index.html                   ← entry point
├── project.json                 ← Wallpaper Engine manifest + user properties
└── src/
    ├── main.js                  ← orchestrator (render loop, wires everything)
    ├── styles/
    │   └── main.css             ← dark cinematic base styles
    ├── lib/
    │   └── sentiment.min.js     ← self-contained AFINN sentiment (no deps)
    ├── bridge/
    │   └── WebNowPlaying.js     ← WebSocket + lrclib.net lyrics provider
    ├── audio/
    │   └── AudioReactivity.js   ← WE audio API + simulation fallback
    ├── text/
    │   └── TextEngine.js        ← Pretext-style layout & measurement
    ├── renderer/
    │   ├── GLRenderer.js        ← WebGL pipeline, FBOs, uniforms
    │   └── TextCanvas.js        ← Canvas2D text → WebGL texture source
    ├── shaders/
    │   └── ShaderLoader.js      ← All GLSL shaders + program builder
    ├── sentiment/
    │   └── SentimentEngine.js   ← Mood mapping + smoothed param lerp
    └── keywords/
        └── KeywordTriggers.js   ← Keyword → one-shot effect triggers
```

---

## 🚀 Setup

### Prerequisites

- [Wallpaper Engine](https://store.steampowered.com/app/431960/Wallpaper_Engine/) (Steam)
- [WebNowPlaying-Redux](https://github.com/keifufu/WebNowPlaying-Redux) browser extension
- WebNowPlaying-Redux **Companion App** running (provides the WebSocket at `localhost:8974`)

### Steps

1. Clone / copy this folder anywhere on your PC
2. In **Wallpaper Engine → Editor → Open from disk** → select `index.html`
3. Or: Package (`project.json` + all files) and load via **Browse → My Wallpapers**
4. Install WebNowPlaying-Redux companion → enable Spotify in the browser extension
5. Play a song — lyrics will begin syncing automatically

> **Demo mode**: If WNP is not connected, demo lyrics cycle automatically so the visualizer always looks alive.

---

## 🎨 Mood → Visual Mapping

| Score | Mood | Color | Effects |
|-------|------|-------|---------|
| ≥ +5 | **Euphoric** | Magenta-Purple | Fast expansion, strong glow, italic font |
| +2–+5 | **Joyful** | Warm Gold | Bouncy motion, bright bloom |
| −1–+2 | **Calm** | Sky Blue | Slow waves, soft blur, heavy trails |
| −4–−1 | **Sad** | Muted Indigo | Heavy trails, desaturated, slow animation |
| ≤ −4 | **Intense** | Hot Red | Glitch bursts, sharp RGB split, fast noise |

---

## 🔑 Keyword Triggers

| Keywords | Effect |
|----------|--------|
| `fire`, `burn`, `flame`, `ignite` | Heat distortion + glitch burst |
| `rain`, `ocean`, `wave`, `drown` | Liquid ripple, slow noise |
| `space`, `stars`, `galaxy`, `void` | Bloom amplified + particle feel |
| `broken`, `crash`, `corrupt`, `chaos` | Maximum glitch + RGB split |
| `heart`, `pulse`, `beat`, `breath` | Rhythmic pulse effect |
| `euphoria`, `paradise`, `bliss` | Max bloom + expansion |

---

## ⚙️ Wallpaper Engine User Properties

These appear in the WE sidebar when the wallpaper is active:

- **Show Debug Overlay** — FPS + live stats
- **Demo Mode** — cycle demo lyrics (default: on)
- **Trail / Ghost Intensity** — feedback decay slider
- **Glow Strength** — bloom intensity
- **Base Font Size** — text size at 1920×1080
- **Distortion Amount** — warp/displacement strength
- **Color Scheme Override** — lock to a specific mood palette

---

## 🧠 GLSL Shader Summary

The main fragment shader (`ShaderLoader.js → fragmentMain`) runs these passes in order:

```
1. FBM noise displacement    → liquid warping of UV coords
2. Glitch bands              → horizontal tearing on keyword trigger
3. RGB chromatic aberration  → per-channel UV offset
4. Text texture sample       → alpha mask from Canvas2D
5. Mood tint                 → lerp text color toward mood palette
6. 8-tap radial glow         → bloom from text alpha
7. Feedback sample + decay   → ping-pong FBO trail (TD Feedback TOP)
8. Hue drift on feedback     → slow color cycling on ghost trails
9. Vignette                  → cinematic edge darkening
10. Grain                    → subtle film noise
```

---

## 🔧 Debug Mode

Add `?debug` to the wallpaper URL (or enable via WE property) to show:

```
FPS       60
Mood      calm
Sentiment 0.125
Bass 0.312   Mid 0.141   High 0.058
Glitch    0.000
Track     Song Name
```

---

## 💡 Extension Ideas

- **Per-word animation** — animate word-by-word using TextEngine character metrics
- **Particle system** — emit particles on keyword "stars" / "fire"
- **Custom shaders** — swap `fragmentMain` for genre-specific effects
- **Spotify Web API** — replace lrclib with direct API fetch for richer metadata
- **Equalizer bars** — render audio bands as vertical bars behind lyrics
- **Multi-line fade** — keep previous line visible with lower opacity (karaoke-style)
- **Web Worker** — move sentiment analysis to a Worker thread for zero-jank processing

---

## 📦 Dependencies

**Zero runtime dependencies.** Everything is vanilla JS / WebGL.

| Library | Why | How |
|---------|-----|-----|
| `sentiment.min.js` | AFINN word scoring | Bundled inline (≈4 KB) |
| Google Fonts | Typography | CDN link in CSS |
| `lrclib.net` | Lyrics API | Fetch call, no key required |

---

*Built with WebGL 1.0 + Canvas 2D · Compatible with Wallpaper Engine Web Wallpaper type*
