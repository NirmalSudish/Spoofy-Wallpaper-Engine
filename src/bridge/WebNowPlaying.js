/**
 * WebNowPlayingBridge
 * -------------------
 * Connects to WebNowPlaying-Redux companion via WebSocket (ws://localhost:8974).
 * Uses lrclib.net for time-synced lyrics (free, no auth required).
 *
 * Protocol: WebNowPlaying-Redux sends JSON messages with track metadata.
 * We track playback position and fire lyric line callbacks on schedule.
 */
export class WebNowPlayingBridge {
  constructor(options = {}) {
    this.wsUrl = options.wsUrl || 'ws://localhost:8974';
    this.reconnectDelay = options.reconnectDelay || 3000;

    this._ws = null;
    this._reconnectTimer = null;
    this._connected = false;

    // Current track state
    this._track = { title: '', artist: '', album: '', coverUrl: '', position: 0, duration: 0, isPlaying: false };

    // Callbacks
    this._onPlayStateChange = null;

    // Lyrics state
    this._lyricsLines = [];   // [{ time: seconds, text: string }]
    this._lyricIndex = -1;
    this._lyricTimer = null;
    this._lastFetchKey = '';

    // Callbacks
    this._onLyricLine = null;
    this._onTrackChange = null;
    this._onConnectionChange = null;

    // Demo mode: cycle placeholder lyrics when no WNP connection
    this._demoMode = options.demo !== false;
    this._demoTimer = null;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  onLyricLine(cb)          { this._onLyricLine = cb; }
  onTrackChange(cb)        { this._onTrackChange = cb; }
  onConnectionChange(cb)   { this._onConnectionChange = cb; }
  onPlayStateChange(cb)    { this._onPlayStateChange = cb; }

  connect() {
    this._openSocket();
  }

  disconnect() {
    clearTimeout(this._reconnectTimer);
    clearTimeout(this._lyricTimer);
    if (this._ws) { this._ws.close(); this._ws = null; }
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────

  _openSocket() {
    try {
      this._ws = new WebSocket(this.wsUrl);
    } catch (e) {
      console.warn('[WNP] WebSocket unavailable, falling back to demo mode.');
      this._startDemoMode();
      return;
    }

    this._ws.onopen = () => {
      console.log('[WNP] Connected to WebNowPlaying-Redux');
      this._connected = true;
      clearTimeout(this._demoTimer);
      this._onConnectionChange && this._onConnectionChange(true);

      // Handshake: identify as web wallpaper client
      this._send({ event: 'tryPair', version: '1.0.0', name: 'LyricsVisualizer' });
    };

    this._ws.onmessage = (e) => {
      try { this._handleMessage(JSON.parse(e.data)); }
      catch (err) { /* ignore malformed */ }
    };

    this._ws.onerror = () => {
      console.warn('[WNP] Connection error');
    };

    this._ws.onclose = () => {
      this._connected = false;
      this._onConnectionChange && this._onConnectionChange(false);
      console.log(`[WNP] Disconnected, retrying in ${this.reconnectDelay}ms…`);
      this._reconnectTimer = setTimeout(() => {
        if (!this._connected) {
          this._openSocket();
        }
      }, this.reconnectDelay);

      // Fall back to demo if we've never connected
      if (!this._track.title) this._startDemoMode();
    };
  }

  _send(obj) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(obj));
    }
  }

  _handleMessage(msg) {
    // WebNowPlaying-Redux message schema
    const { event, data } = msg;

    if (event === 'eventResult' || event === 'pairResult') return;

    if (event === 'PLAYER_UPDATED' || event === 'playerUpdate' || msg.title) {
      const payload = data || msg;
      const prevTitle = this._track.title;

      this._track.title    = payload.title    || payload.name  || this._track.title;
      this._track.artist   = payload.artist   || payload.author || this._track.artist;
      this._track.album    = payload.album    || this._track.album;
      this._track.coverUrl = payload.coverUrl || this._track.coverUrl;
      this._track.position = parseFloat(payload.position || payload.currentTime || 0);
      this._track.duration = parseFloat(payload.duration || payload.totalTime || 0);
      const wasPlaying = this._track.isPlaying;
      this._track.isPlaying = payload.state === 1 || payload.isPlaying === true;

      // Fire track change if title changed
      if (this._track.title && this._track.title !== prevTitle) {
        this._onTrackChange && this._onTrackChange(this._track.title, this._track.artist, this._track.coverUrl);
        this._fetchLyrics();
      }

      // Fire play state change when it flips
      if (this._track.isPlaying !== wasPlaying) {
        this._onPlayStateChange && this._onPlayStateChange(this._track.isPlaying);

        if (!this._track.isPlaying) {
          // Paused — stop the lyric timer so lines don't keep firing silently
          clearTimeout(this._lyricTimer);
          this._lyricTimer = null;
        } else if (this._lyricsLines.length) {
          // Resumed — re-anchor and restart scheduling from current position
          this._syncToPosition(this._track.position);
        }
      }

      // Re-anchor playback position so interpolation stays accurate (playing only)
      if (this._track.isPlaying) {
        if (this._lyricsLines.length) {
          this._syncToPosition(this._track.position);
        }
        this._syncAnchorPos  = this._track.position;
        this._syncAnchorTime = performance.now();
      }
    }
  }

  // ── Lyrics via lrclib.net ─────────────────────────────────────────────────

  async _fetchLyrics() {
    const key = `${this._track.artist}___${this._track.title}`;
    if (key === this._lastFetchKey) return;
    this._lastFetchKey = key;

    this._lyricsLines = [];
    this._lyricIndex  = -1;
    clearTimeout(this._lyricTimer);

    const title  = encodeURIComponent(this._track.title.trim());
    const artist = encodeURIComponent(this._track.artist.trim());
    const album  = encodeURIComponent(this._track.album.trim());

    // Try with album first, then without (album name from Spotify often differs
    // from lrclib's version, e.g. "Deluxe Edition" suffixes break exact match)
    const urls = [
      `https://lrclib.net/api/get?artist_name=${artist}&track_name=${title}&album_name=${album}`,
      `https://lrclib.net/api/get?artist_name=${artist}&track_name=${title}`,
    ];

    let lrc = '';
    for (const url of urls) {
      try {
        console.log('[WNP] Fetching lyrics:', url);
        const res  = await fetch(url);
        if (!res.ok) continue;
        const json = await res.json();
        lrc = json.syncedLyrics || json.plainLyrics || '';
        if (lrc) break;
      } catch (err) {
        console.warn('[WNP] Lyrics fetch error:', err.message);
      }
    }

    if (!lrc) {
      console.warn('[WNP] No lyrics found for:', this._track.artist, '—', this._track.title);
      return; // no lyrics — leave canvas blank, don't start demo
    }

    this._lyricsLines = this._parseLRC(lrc);
    console.log(`[WNP] Loaded ${this._lyricsLines.length} lyric lines`);
    // Use interpolated position — fetch takes ~300ms so _track.position is stale
    this._syncToPosition(this._currentPos());
  }

  _parseLRC(lrc) {
    const lines = [];
    const re = /\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/;

    lrc.split('\n').forEach(raw => {
      const m = raw.match(re);
      if (!m) return;
      const min  = parseInt(m[1], 10);
      const sec  = parseInt(m[2], 10);
      const ms   = parseInt(m[3].padEnd(3, '0'), 10);
      const time = min * 60 + sec + ms / 1000;
      const text = m[4].trim();
      if (text) lines.push({ time, text });
    });

    return lines.sort((a, b) => a.time - b.time);
  }

  _syncToPosition(posSeconds) {
    if (!this._lyricsLines.length) return;
    clearTimeout(this._lyricTimer);

    // Anchor wall-clock time so we can interpolate position between polls
    this._syncAnchorPos  = posSeconds;
    this._syncAnchorTime = performance.now();

    this._scheduleFrom(posSeconds);
  }

  // Returns the best-guess current playback position using the last anchor
  _currentPos() {
    if (!this._track.isPlaying) return this._syncAnchorPos || 0;
    const elapsed = (performance.now() - (this._syncAnchorTime || performance.now())) / 1000;
    return (this._syncAnchorPos || 0) + elapsed;
  }

  _scheduleFrom(posSeconds) {
    if (!this._lyricsLines.length) return;

    // Find where we are in the lyrics
    let idx = -1;
    for (let i = 0; i < this._lyricsLines.length; i++) {
      if (this._lyricsLines[i].time <= posSeconds) idx = i;
      else break;
    }

    // Fire current line immediately if it hasn't been shown yet
    if (idx >= 0 && idx !== this._lyricIndex) {
      this._lyricIndex = idx;
      this._fireLine(this._lyricsLines[idx].text);
    }

    // Schedule the next line using wall-clock interpolation
    const nextIdx = idx + 1;
    if (nextIdx < this._lyricsLines.length) {
      const next  = this._lyricsLines[nextIdx];
      const delay = Math.max(0, (next.time - posSeconds) * 1000);
      this._lyricTimer = setTimeout(() => {
        // Re-check using interpolated position in case of slight drift
        const now = this._currentPos();
        this._lyricIndex = nextIdx;
        this._fireLine(next.text);
        this._scheduleFrom(Math.max(next.time, now));
      }, delay);
    }
  }

  _fireLine(text) {
    if (text && text.trim()) {
      console.log('[WNP] Lyric:', text);
      this._onLyricLine && this._onLyricLine(text.trim());
    }
  }

  // ── Demo Mode ─────────────────────────────────────────────────────────────

  _startDemoMode() {
    if (!this._demoMode) return;
    clearTimeout(this._demoTimer);

    const demoTrack  = 'Demo – Lyrics Visualizer';
    const demoArtist = 'WebGL Edition';
    const demoLyrics = [
      'Lost in the neon glow of midnight rain',
      'The city burns bright in shades of crimson flame',
      'I hear your voice across the ocean of stars',
      'Dancing on the edge between heaven and dark',
      'Every heartbeat echoes in the silence',
      'We rise and fall like waves against the tide',
      'Fire in my veins, shadow in my soul',
      'Together we are whole, forever and more',
      'The storm inside rages like fury and light',
      'But I find my peace in the eye of the night',
      'Scream into the void and the void screams back',
      'Love is the only color this dark world lacks',
      'Underneath the galaxy we burn and shine',
      'Your name echoes through the corridors of time',
      'I was broken, lost, and falling through the dark',
      'But you became the light inside my heart',
    ];

    this._onTrackChange && this._onTrackChange(demoTrack, demoArtist, '');

    // Simulate position for progress bar
    const demoDuration = demoLyrics.length * 4.5;
    this._track.duration = demoDuration;
    this._track.position = 0;
    const posInterval = setInterval(() => {
      if (!this._demoMode) { clearInterval(posInterval); return; }
      this._track.position = Math.min(this._track.position + 0.1, demoDuration);
    }, 100);

    let i = 0;
    const fireNext = () => {
      this._fireLine(demoLyrics[i % demoLyrics.length]);
      i++;
      this._demoTimer = setTimeout(fireNext, 4500);
    };
    fireNext();
  }
}
