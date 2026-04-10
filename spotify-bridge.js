#!/usr/bin/env node
/**
 * spotify-bridge.js
 * -----------------
 * Polls the Spotify Web API for the currently playing track and re-broadcasts
 * it over a local WebSocket server at ws://localhost:8974 — the same address
 * the Wallpaper Engine wallpaper already connects to.
 *
 * One-time setup:
 *   1. Go to https://developer.spotify.com/dashboard and create an app.
 *   2. In the app settings, add this Redirect URI: http://localhost:8888/callback
 *   3. Copy the Client ID and paste it below (or set env var SPOTIFY_CLIENT_ID).
 *   4. Run: npm install
 *   5. Run: node spotify-bridge.js
 *      — Your browser will open for Spotify login on first run.
 *      — Token is saved to .spotify-token.json so you only log in once.
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { WebSocketServer } = require('ws');
const SysTray = require('systray2').default;

// ── Config ────────────────────────────────────────────────────────────────────
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '12b1b8cad57c4c01987d8e19b9e1dac9';
const REDIRECT = 'http://127.0.0.1:8888/callback';
const SCOPES = 'user-read-currently-playing user-read-playback-state user-modify-playback-state';
const WS_PORT = 8974;     // must match wallpaper's WebNowPlaying.js wsUrl
const OAUTH_PORT = 8888;
const CTRL_PORT  = 8889;  // HTTP control API for play/pause/skip

// When packaged with 'pkg', __dirname is a virtual read-only snapshot.
// We must save tokens relative to the actual .exe file on disk.
const IS_PKG = typeof process.pkg !== 'undefined';
const EXEC_DIR = IS_PKG ? path.dirname(process.execPath) : __dirname;
const TOKEN_FILE = path.join(EXEC_DIR, '.spotify-token.json');
const POLL_MS       = 5000;  // normal poll interval — safe within Spotify's rate limit
const POLL_FAST_MS  = 1000;  // used briefly after a control action
const POLL_IDLE_MS  = 30000; // nothing playing — check every 30 s instead of 5 s
const POLL_MAX_MS   = 30000; // back-off ceiling when rate-limited (network errors)

// ── Log capturing for UI ──────────────────────────────────────────────────────
const logs = [];
function addLog(msg) {
  logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
  if (logs.length > 30) logs.shift();
}
const origLog = console.log;
console.log = (...args) => { const msg = args.map(String).join(' '); addLog(msg); origLog.apply(console, args); };
const origWarn = console.warn;
console.warn = (...args) => { const msg = args.map(String).join(' '); addLog(msg); origWarn.apply(console, args); };
const origErr = console.error;
console.error = (...args) => { const msg = args.map(String).join(' '); addLog(msg); origErr.apply(console, args); };

// ── Startup Registry Logic ────────────────────────────────────────────────────
const APP_NAME = 'SpotifyWallpaperBridge';

function checkStartup() {
  return new Promise(resolve => {
    exec(`powershell -Command "(Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run').${APP_NAME}"`, (err, stdout) => {
      resolve(!err && stdout && stdout.trim().length > 0);
    });
  });
}

function setStartup(enable) {
  return new Promise(resolve => {
    if (enable) {
      // Setup hidden window launch for startup natively via powershell parameters
      const exePath = `\`"${process.execPath}\`" --startup`;
      exec(`powershell -Command "Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name '${APP_NAME}' -Value '${exePath}' -Type String"`, err => resolve(!err));
    } else {
      exec(`powershell -Command "Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name '${APP_NAME}'"`, err => resolve(!err));
    }
  });
}

// ── Web UI HTML ───────────────────────────────────────────────────────────────
function openAppWindow() {
  const url = 'http://127.0.0.1:8889';
  exec(`start msedge --app=${url}`, (err) => {
    if (err) {
      exec(`start chrome --app=${url}`, (err2) => {
        if (err2) exec(`start ${url}`); // pure fallback
      });
    }
  });
}

const UI_HTML = `<!DOCTYPE html>
<html>
<head>
    <title>Spotify Bridge Settings</title>
    <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #121212; color: #fff; text-align: center; margin: 0; padding: 40px; }
        .container { background: #1e1e1e; max-width: 400px; margin: 0 auto; padding: 30px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.5); }
        h2 { color: #1DB954; margin-top: 0; margin-bottom: 20px; }
        .status { margin-bottom: 25px; font-size: 1.1em; color: #b3b3b3; min-height: 25px; }
        .btn { background: #1DB954; color: black; border: none; padding: 12px 24px; font-size: 1em; font-weight: bold; border-radius: 30px; cursor: pointer; transition: transform 0.1s, background 0.2s; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
        .btn:hover { background: #1ed760; transform: scale(1.02); }
        .btn:active { transform: scale(0.98); }
        .footer { margin-top: 35px; font-size: 0.8em; color: #666; }
        .badge { display: inline-block; padding: 4px 12px; border-radius: 12px; background: rgba(29, 185, 84, 0.2); color: #1DB954; font-size: 0.85em; font-weight: bold; margin-bottom: 15px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="badge" id="badgeText">Running</div>
        <h2>Spotify Bridge</h2>
        <div>
            <button class="btn" id="loginBtn" style="display:none; background:#1DB954; color:black; margin-bottom: 25px;" onclick="connectSpotify()">Connect to Spotify</button>
        </div>
        <div class="status" id="statusText">Checking status...</div>
        <div>
            <button class="btn" id="startupBtn" onclick="toggleStartup()">Loading...</button>
        </div>
        <div class="footer">Wallpaper Engine Bridge is active.</div>
        <div class="logs-container" id="logsBox" style="font-family: monospace; font-size: 0.85em; color: #a9a9a9; background: #121212; border-radius: 8px; padding: 10px; margin-top: 20px; text-align: left; height: 100px; overflow-y: auto;">
             > Starting bridge...
        </div>
    </div>
    <script>
        let isStartup = false;
        async function fetchStatus() {
            try {
                const res = await fetch('/status');
                const data = await res.json();
                if (data.needsAuth) {
                    document.getElementById('loginBtn').style.display = 'inline-block';
                    document.getElementById('badgeText').innerText = 'Action Required';
                    document.getElementById('badgeText').style.background = 'rgba(226, 33, 52, 0.2)';
                    document.getElementById('badgeText').style.color = '#e22134';
                    document.getElementById('statusText').innerText = 'Please connect your Spotify account.';
                } else {
                    document.getElementById('loginBtn').style.display = 'none';
                    document.getElementById('badgeText').innerText = 'Connected';
                    document.getElementById('badgeText').style.background = 'rgba(29, 185, 84, 0.2)';
                    document.getElementById('badgeText').style.color = '#1DB954';
                    document.getElementById('statusText').innerText = 
                        data.currentTrack !== '(none)' 
                        ? "Playing: " + data.currentTrack 
                        : "Status: " + data.poll;
                }
            } catch (e) {
                document.getElementById('statusText').innerText = 'Bridge disconnected. Refresh?';
            }
        }
        function connectSpotify() {
            fetch('/api/login', { method: 'POST' });
            document.getElementById('loginBtn').innerText = 'Check browser...';
        }
        async function fetchStartup() {
            try {
                const res = await fetch('/api/startup');
                const data = await res.json();
                isStartup = data.enabled;
                updateBtn();
            } catch (e) {}
        }
        async function toggleStartup() {
            try {
                const res = await fetch('/api/startup', { method: 'POST', body: JSON.stringify({ enable: !isStartup }), headers: { 'Content-Type': 'application/json' } });
                const data = await res.json();
                isStartup = data.enabled;
                updateBtn();
            } catch (e) {}
        }
        function updateBtn() {
            const btn = document.getElementById('startupBtn');
            btn.innerText = isStartup ? "Disable Run on Startup" : "Enable Run on Startup";
            btn.style.background = isStartup ? "#e22134" : "#1DB954";
            btn.style.color = isStartup ? "#fff" : "#000";
        }
        async function fetchLogs() {
            try {
                const res = await fetch('/api/logs');
                const data = await res.json();
                const box = document.getElementById('logsBox');
                // Create HTML without overwriting if nothing changed
                const newHtml = data.map(l => "<div>> " + l + "</div>").join('');
                if (box.innerHTML !== newHtml) {
                    box.innerHTML = newHtml;
                    box.scrollTop = box.scrollHeight;
                }
            } catch (e) {}
        }
        fetchStatus();
        fetchLogs();
        setInterval(fetchStatus, 5000);
        setInterval(fetchLogs, 2000);
        fetchStartup();
    </script>
</body>
</html>`;

// ── State ─────────────────────────────────────────────────────────────────────
let accessToken  = null;
let refreshToken = null;
let tokenExpiry  = 0;
let pollInterval = POLL_MS;      // current interval (may be backed-off)
let pollPaused   = false;        // true while honouring Retry-After
let fastPollCount = 0;           // remaining fast-poll ticks after a control action
let pollTimer    = null;         // handle for the current setTimeout
const clients    = new Set();
let lastBroadcast = {};          // used to skip identical consecutive broadcasts
let consecutiveRateLimits = 0;   // how many 429s in a row — drives exponential back-off
let lastSuccessfulPoll = null;   // wall-clock time of last 200 OK from Spotify
let lastPollStatus = 'starting'; // human-readable status for /status endpoint

// ── PKCE helpers ──────────────────────────────────────────────────────────────
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
const makeVerifier = () => b64url(crypto.randomBytes(32));
const makeChallenge = (v) => b64url(crypto.createHash('sha256').update(v).digest());

// ── Token persistence ─────────────────────────────────────────────────────────
function saveTokens(access, refresh, expiresIn) {
  accessToken = access;
  refreshToken = refresh;
  tokenExpiry = Date.now() + (expiresIn - 60) * 1000; // 60 s safety buffer
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ accessToken, refreshToken, tokenExpiry }));
  } catch { /* non-fatal */ }
}

function loadTokens() {
  try {
    const d = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    accessToken = d.accessToken;
    refreshToken = d.refreshToken;
    tokenExpiry = d.tokenExpiry;
    return !!refreshToken;
  } catch {
    return false;
  }
}

// ── Native HTTPS helpers ──────────────────────────────────────────────────────
function httpsPost(url, bodyObj, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(bodyObj).toString();
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        ...extraHeaders,
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error(raw)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpsGet(url, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { Authorization: `Bearer ${token}` },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode === 204) { resolve(null); return; } // nothing playing
        let body = null;
        try { body = JSON.parse(raw); } catch { /* non-JSON body (e.g. 429 plain text) */ }
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    }).on('error', reject);
  });
}

// ── Token management ──────────────────────────────────────────────────────────
async function refreshAccessToken() {
  console.log('[Auth] Refreshing access token...');
  const data = await httpsPost('https://accounts.spotify.com/api/token', {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });

  if (data.access_token) {
    saveTokens(data.access_token, data.refresh_token || refreshToken, data.expires_in || 3600);
    console.log('[Auth] Token refreshed successfully.');
  } else {
    console.error('[Auth] Token refresh failed:', JSON.stringify(data));
    // Force re-auth on next startup
    try { fs.unlinkSync(TOKEN_FILE); } catch { }
    console.error('[Auth] Deleted saved tokens. Re-run to log in again.');
    process.exit(1);
  }
}

async function ensureToken() {
  if (accessToken && Date.now() >= tokenExpiry) {
    await refreshAccessToken();
  }
}

// ── OAuth PKCE flow ───────────────────────────────────────────────────────────
function startOAuth() {
  return new Promise((resolve) => {
    const verifier = makeVerifier();
    const challenge = makeChallenge(verifier);
    const state = crypto.randomBytes(8).toString('hex');

    const authUrl = 'https://accounts.spotify.com/authorize?'
      + `client_id=${CLIENT_ID}`
      + `&response_type=code`
      + `&redirect_uri=${encodeURIComponent(REDIRECT)}`
      + `&scope=${encodeURIComponent(SCOPES)}`
      + `&code_challenge_method=S256`
      + `&code_challenge=${challenge}`
      + `&state=${state}`;

    console.log('\n[Auth] Opening browser for Spotify authorization...');
    console.log('[Auth] If the browser does not open automatically, visit:\n');
    console.log('  ', authUrl, '\n');

    // Open default browser on Windows
    exec(`start "" "${authUrl}"`, (err) => {
      if (err) console.warn('[Auth] Could not open browser automatically:', err.message);
    });

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${OAUTH_PORT}`);
      if (url.pathname !== '/callback') { res.end(); return; }

      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error || !code) {
        res.end('<html><body><h2>Authorization failed: ' + (error || 'no code') + '</h2></body></html>');
        server.close();
        process.exit(1);
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body style="font-family:sans-serif;text-align:center;margin-top:80px">'
        + '<h2>Authorized! You can close this tab.</h2>'
        + '<p>The Spotify bridge is now running.</p></body></html>');

      server.close();

      // Exchange authorization code for tokens
      try {
        const data = await httpsPost('https://accounts.spotify.com/api/token', {
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT,
          client_id: CLIENT_ID,
          code_verifier: verifier,
        });

        if (data.access_token) {
          saveTokens(data.access_token, data.refresh_token, data.expires_in || 3600);
          console.log('[Auth] Authorization successful. Tokens saved to .spotify-token.json');
          resolve();
        } else {
          console.error('[Auth] Token exchange failed:', JSON.stringify(data));
          process.exit(1);
        }
      } catch (e) {
        console.error('[Auth] Token exchange error:', e.message);
        process.exit(1);
      }
    });

    server.listen(OAUTH_PORT, () => {
      console.log(`[Auth] Waiting for Spotify callback on port ${OAUTH_PORT}...`);
    });
  });
}

// ── Spotify control (PUT/POST) ────────────────────────────────────────────────
function spotifyControl(method, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.spotify.com',
      path,
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Length': 0,
      },
    }, (res) => {
      res.resume(); // drain body
      console.log(`[Ctrl] Spotify ${method} ${path} → ${res.statusCode}`);
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Album art proxy (pipes Spotify CDN images to avoid file:// CORS block) ────
function proxyArt(imageUrl, res) {
  return new Promise((resolve, reject) => {
    const u = new URL(imageUrl);
    https.get({ hostname: u.hostname, path: u.pathname + u.search }, (imgRes) => {
      res.writeHead(200, {
        'Content-Type':  imgRes.headers['content-type'] || 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
      });
      imgRes.pipe(res);
      imgRes.on('end', resolve);
    }).on('error', reject);
  });
}

// ── HTTP control server (play/pause/next/prev + art proxy) ───────────────────
function startControlServer() {
  const server = http.createServer(async (req, res) => {
    // Allow wallpaper (file:// or localhost) to call us
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // ── Web UI (/) ────────────────────────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(UI_HTML);
      return;
    }

    // ── Startup Toggle API ────────────────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/api/startup') {
      const enabled = await checkStartup();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ enabled }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/startup') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { enable } = JSON.parse(body);
          const success = await setStartup(enable);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ enabled: enable && success }));
        } catch {
          res.writeHead(400); res.end();
        }
      });
      return;
    }

    // ── Login API ─────────────────────────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/api/login') {
      res.writeHead(200); res.end();
      if (!accessToken) startOAuth();
      return;
    }

    // ── Logs API ──────────────────────────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/api/logs') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(logs));
      return;
    }

    // ── Status page (/status) ─────────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/status') {
      const status = {
        needsAuth:        !accessToken,
        poll:             lastPollStatus,
        lastSuccessAt:    lastSuccessfulPoll || 'never',
        consecutive429s:  consecutiveRateLimits,
        wsClients:        clients.size,
        currentTrack:     lastBroadcast.title || '(none)',
        isPlaying:        lastBroadcast.isPlaying ?? false,
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status, null, 2));
      return;
    }

    // ── Album art proxy (/art?url=<encoded>) ─────────────────────────────
    if (req.method === 'GET' && req.url.startsWith('/art?')) {
      try {
        const params   = new URL(req.url, `http://127.0.0.1:${CTRL_PORT}`).searchParams;
        const imageUrl = params.get('url');
        if (!imageUrl) { res.writeHead(400); res.end(); return; }
        await proxyArt(imageUrl, res);
      } catch (e) {
        console.warn('[Art] Proxy error:', e.message);
        if (!res.headersSent) { res.writeHead(502); res.end(); }
      }
      return;
    }

    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

    try {
      await ensureToken();

      if      (req.url === '/play')  await spotifyControl('PUT',  '/v1/me/player/play');
      else if (req.url === '/pause') await spotifyControl('PUT',  '/v1/me/player/pause');
      else if (req.url === '/next')  await spotifyControl('POST', '/v1/me/player/next');
      else if (req.url === '/prev')  await spotifyControl('POST', '/v1/me/player/previous');
      else { res.writeHead(404); res.end(); return; }

      // Trigger a few fast polls so the wallpaper updates quickly after the action
      fastPollCount = 4;
      res.writeHead(204); res.end();
    } catch (e) {
      console.warn('[Ctrl] Error:', e.message);
      res.writeHead(500); res.end();
    }
  });

  server.listen(CTRL_PORT, '127.0.0.1', () => {
    console.log(`[Ctrl] Control server on http://127.0.0.1:${CTRL_PORT}`);
  });
}

// ── WebSocket broadcast ───────────────────────────────────────────────────────
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of clients) {
    if (client.readyState === 1 /* OPEN */) {
      client.send(msg);
    }
  }
}

// ── Spotify poll ──────────────────────────────────────────────────────────────
async function poll() {
  if (pollPaused || !accessToken) return;

  try {
    await ensureToken();

    const result = await httpsGet(
      'https://api.spotify.com/v1/me/player/currently-playing?additional_types=track',
      accessToken
    );

    // 204 = nothing playing — back off so we don't waste API calls
    if (!result) {
      lastPollStatus = 'idle (nothing playing)';
      pollInterval   = POLL_IDLE_MS;
      return;
    }

    const { status, body } = result;

    // ── Handle error status codes first ──────────────────────────────────
    if (status === 429) {
      consecutiveRateLimits++;
      // Exponential back-off: 30s → 45s → 67s → 101s → ... capped at 300s (5 min)
      const backoffSecs = Math.min(300, Math.round(30 * Math.pow(1.5, consecutiveRateLimits - 1)));
      lastPollStatus = `rate-limited (${consecutiveRateLimits}x) — retry in ${backoffSecs}s`;
      console.warn(`[Poll] Rate limited (${consecutiveRateLimits}x consecutive) — waiting ${backoffSecs}s`);
      pollPaused = true;
      setTimeout(() => { pollPaused = false; }, backoffSecs * 1000);
      return;
    }

    if (status === 401) {
      await refreshAccessToken();
      return;
    }

    if (status !== 200) return;

    // 200 — back to normal interval, reset rate-limit counter
    consecutiveRateLimits = 0;
    lastSuccessfulPoll    = new Date().toLocaleTimeString();
    lastPollStatus        = 'ok';
    pollInterval = fastPollCount > 0 ? POLL_FAST_MS : POLL_MS;

    if (!body?.item) return;

    const item      = body.item;
    const title     = item.name || '';
    const artist    = (item.artists || []).map(a => a.name).join(', ');
    const album     = item.album?.name || '';
    const position  = (body.progress_ms || 0) / 1000;
    const duration  = (item.duration_ms || 0) / 1000;
    const isPlaying = body.is_playing === true;
    const images    = item.album?.images || [];
    const coverUrl  = (images.find(img => img.width <= 300) || images[images.length - 1])?.url || '';

    // Skip broadcast if nothing meaningful changed (avoids hammering the wallpaper)
    const posChanged = Math.abs((lastBroadcast.position || 0) - position) > 1.5;
    const changed    = lastBroadcast.title     !== title
                    || lastBroadcast.isPlaying !== isPlaying
                    || posChanged;

    if (changed) {
      const payload = { title, artist, album, coverUrl, position, duration, state: isPlaying ? 1 : 0 };
      lastBroadcast = { title, isPlaying, position, _payload: payload };
      broadcast(payload);
    }

  } catch (e) {
    console.warn('[Poll] Error:', e.message);
    lastPollStatus = `error: ${e.message}`;
    pollInterval = Math.min(POLL_MAX_MS, pollInterval * 2); // exponential back-off on network errors
  }
}

// ── Dynamic poll loop (setTimeout instead of setInterval so we can vary rate) ─
function schedulePoll() {
  if (fastPollCount > 0) fastPollCount--;
  pollTimer = setTimeout(async () => {
    await poll();
    schedulePoll();
  }, pollPaused ? POLL_MS : pollInterval);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Hide the black terminal window (Windows only feature) using PowerShell
  // This avoids C++ ABI mismatch errors when compiling with 'pkg'
  exec(`powershell -windowstyle hidden -Command "Add-Type -Name Window -Namespace Console -MemberDefinition '[DllImport(\\"user32.dll\\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); [DllImport(\\"kernel32.dll\\")] public static extern IntPtr GetConsoleWindow();'; [Console.Window]::ShowWindow([Console.Window]::GetConsoleWindow(), 0);"`);

  // Create a system tray icon so the user can easily close it
  const systray = new SysTray({
    menu: {
      icon: "", // We can leave this blank, it'll use a default or empty icon space
      title: "Spotify Bridge",
      tooltip: "Spotify → Wallpaper Engine Bridge",
      items: [
        {
          title: "Open Settings UI",
          tooltip: "Configure Startup",
          checked: false,
          enabled: true
        },
        {
          title: "Exit",
          tooltip: "Close completely",
          checked: false,
          enabled: true
        }
      ]
    },
    debug: false,
    copyDir: true, // Crucial for 'pkg' to extract traybin to temp dir
  });

  systray.onClick(action => {
    if (action.item.title === "Exit") {
      systray.kill();
      process.exit(0);
    }
    if (action.item.title === "Open Settings UI") {
      openAppWindow();
    }
  });

  systray.ready().catch(err => {
    console.warn('[SysTray] Failed to start:', err.message);
  });

  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   Spotify → Wallpaper Engine Lyrics Bridge   ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  if (CLIENT_ID === 'YOUR_CLIENT_ID_HERE') {
    console.error('[Error] You need to set your Spotify Client ID.');
    console.error('');
    console.error('  1. Go to https://developer.spotify.com/dashboard');
    console.error('  2. Create an app (any name)');
    console.error('  3. Add Redirect URI: http://localhost:8888/callback');
    console.error('  4. Copy the Client ID');
    console.error('  5. Open spotify-bridge.js and replace YOUR_CLIENT_ID_HERE');
    console.error('     — OR — run:  set SPOTIFY_CLIENT_ID=your_id_here && node spotify-bridge.js');
    process.exit(1);
  }

  // Start HTTP control server FIRST to serve UI
  startControlServer();

  // If launched manually (no --startup flag), open the dashboard UI
  if (!process.argv.includes('--startup')) {
    openAppWindow();
  }

  // Try to load saved tokens
  const hadSavedTokens = loadTokens();

  if (hadSavedTokens) {
    console.log('[Auth] Found saved tokens, refreshing...');
    try {
      await refreshAccessToken();
    } catch (e) {
      console.warn('[Auth] Could not refresh, user needs re-auth.');
      try { fs.unlinkSync(TOKEN_FILE); } catch { }
    }
  }

  // Start WebSocket server
  const wss = new WebSocketServer({ port: WS_PORT });

  wss.on('listening', () => {
    console.log(`[WS]   WebSocket server running on ws://localhost:${WS_PORT}`);
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    console.log(`[WS]   Wallpaper connected (${clients.size} client(s))`);

    // Send last known state immediately so the wallpaper doesn't wait for next poll
    if (lastBroadcast.title && ws.readyState === 1) {
      ws.send(JSON.stringify(lastBroadcast._payload || {}));
    }

    ws.on('close', () => {
      clients.delete(ws);
      console.log(`[WS]   Wallpaper disconnected (${clients.size} client(s))`);
    });

    ws.on('message', () => { });
  });

  wss.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[WS]   Port ${WS_PORT} is already in use.`);
      process.exit(1);
    }
  });

  // Poll loop — dynamic rate, respects 429 Retry-After
  console.log(`[Poll] Polling Spotify every ${POLL_MS}ms...\n`);
  await poll(); // immediate first poll
  schedulePoll();

  console.log('[Ready] Bridge is running. Start Wallpaper Engine and play a song on Spotify.');
  console.log('        Press Ctrl+C to stop.\n');
}

main().catch((e) => {
  console.error('[Fatal]', e.message);
  process.exit(1);
});
