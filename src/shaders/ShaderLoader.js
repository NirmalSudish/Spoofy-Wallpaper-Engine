/**
 * ShaderLoader
 * ------------
 * Full WebGL effect pipeline embedded as template literals.
 *
 * Effect pipeline (fragmentMain) — in order:
 *  1.  Glitch bands              — keyword-triggered horizontal tearing
 *  2a. Liquid surface refraction — noise-gradient UV warp on text (uRefraction)
 *  2b. 3D perspective tilt       — animated perspective transform on text (uPerspTilt)
 *  3.  RGB chromatic aberration  — per-channel UV offset
 *  4.  Text texture sample
 *  5.  Mood tint
 *  6.  Rainbow / prismatic       — hue-cycle text color (uRainbow)
 *  7.  Iridescent shimmer        — holographic sweep on text (uIridescence)
 *  8.  Beat brightness flash
 *  9.  Inner glow                — tight 8-tap radial bloom
 *  10. Outer aura                — 12-tap wide soft halo (uOuterGlowMult)
 *  11. Caustic patterns          — animated light-through-water (uCaustics)
 *  12. FBM noise displacement    — feedback trail warping
 *  13. Feedback sample + decay   — ping-pong FBO ghost trails
 *  14. Hue drift on trails
 *  15. Composite
 *  16. Beat pulse rings          — expanding rings (uBeatPulse)
 *  17. God rays                  — volumetric light shafts from text (uGodRays)
 *  18. CRT scanlines             — (uScanlines)
 *  19. Vignette
 *  20. Film grain
 */

export const SHADERS = {

  // ── Vertex shader (shared) ───────────────────────────────────────────────
  vertex: /* glsl */`
    attribute vec2 aPosition;
    varying   vec2 vUv;
    void main() {
      vUv = aPosition * 0.5 + 0.5;
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }
  `,

  // ── Main fragment shader ─────────────────────────────────────────────────
  fragmentMain: /* glsl */`
    precision highp float;

    uniform sampler2D uTextTexture;
    uniform sampler2D uFeedback;

    uniform float uTime;
    uniform float uSentiment;
    uniform float uBass;
    uniform float uMid;
    uniform float uHigh;

    // Mood-driven params
    uniform float uDistortion;
    uniform float uNoiseFreq;
    uniform float uNoiseSpeed;
    uniform float uFeedbackDecay;
    uniform float uGlowStrength;
    uniform float uRGBShift;
    uniform float uGlitch;
    uniform vec3  uMoodColor;

    // Previous effect uniforms
    uniform float uBeatPulse;
    uniform float uScanlines;
    uniform float uRainbow;
    uniform float uOuterGlowMult;

    // New effect uniforms
    uniform float uRefraction;    // 0–1  liquid surface normal warp on text
    uniform float uCaustics;      // 0–1  animated caustic light patterns
    uniform float uPerspTilt;     // 0–1  animated 3D perspective tilt
    uniform float uIridescence;   // 0–1  holographic shimmer on text
    uniform float uGodRays;       // 0–1  volumetric light shafts from text center

    varying vec2 vUv;

    // ── Simplex Noise 2D ─────────────────────────────────────────────────────
    vec3 _m289v3(vec3 x){ return x - floor(x*(1./289.))*289.; }
    vec2 _m289v2(vec2 x){ return x - floor(x*(1./289.))*289.; }
    vec3 _perm(vec3 x){ return _m289v3(((x*34.)+1.)*x); }

    float snoise(vec2 v) {
      const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                          -0.577350269189626, 0.024390243902439);
      vec2 i  = floor(v + dot(v, C.yy));
      vec2 x0 = v - i + dot(i, C.xx);
      vec2 i1  = (x0.x > x0.y) ? vec2(1.,0.) : vec2(0.,1.);
      vec4 x12 = x0.xyxy + C.xxzz;
      x12.xy -= i1;
      i = _m289v2(i);
      vec3 p = _perm(_perm(i.y+vec3(0.,i1.y,1.))+i.x+vec3(0.,i1.x,1.));
      vec3 m = max(.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.);
      m=m*m; m=m*m;
      vec3 x  = 2.*fract(p*C.www)-1.;
      vec3 h  = abs(x)-.5;
      vec3 ox = floor(x+.5);
      vec3 a0 = x-ox;
      m *= 1.79284291400159-0.85373472095314*(a0*a0+h*h);
      vec3 g;
      g.x  = a0.x*x0.x   + h.x*x0.y;
      g.yz = a0.yz*x12.xz + h.yz*x12.yw;
      return 130.*dot(m,g);
    }

    // ── FBM ─────────────────────────────────────────────────────────────────
    float fbm(vec2 v) {
      float val=0., amp=0.5, freq=1.;
      for(int i=0;i<4;i++){ val+=snoise(v*freq)*amp; freq*=2.1; amp*=0.5; }
      return val;
    }

    // ── HSV → RGB ────────────────────────────────────────────────────────────
    vec3 hsv2rgb(vec3 c) {
      vec4 K = vec4(1.0,2.0/3.0,1.0/3.0,3.0);
      vec3 p = abs(fract(c.xxx+K.xyz)*6.0-K.www);
      return c.z * mix(K.xxx, clamp(p-K.xxx,0.0,1.0), c.y);
    }

    // ── Caustic light pattern ────────────────────────────────────────────────
    // Interference of offset sine waves → light-through-water look
    float causticVal(vec2 p, float t) {
      float c = sin(p.x*1.1 + p.y*0.8  + t*1.05)
              + sin(p.x*0.7 - p.y*1.3  + t*0.88)
              + sin((p.x+p.y)*0.85      + t*0.72)
              + sin(p.x*1.5             + t*0.93);
      // Fold toward sharp bright caustic lines
      return pow(abs(sin(c * 0.55 + t * 0.28)), 2.2);
    }

    void main() {
      vec2 uv = vUv;

      // ── 1. Glitch bands ──────────────────────────────────────────────────
      vec2 glitchUv = uv;
      if (uGlitch > 0.01) {
        float gt       = uTime * 18.;
        float bandMask = step(0.93, snoise(vec2(uv.y*28., floor(gt))));
        float shift    = (snoise(vec2(gt*40.,0.))*2.-1.) * uGlitch * 0.09;
        glitchUv.x    += bandMask * shift;
        float tearMask = step(0.97, snoise(vec2(uv.y*60., gt*0.5)));
        glitchUv       = mix(glitchUv, vec2(fract(glitchUv.x+0.5),glitchUv.y), tearMask*uGlitch*0.5);
      }

      // ── 2a. Liquid surface refraction (noise-gradient normals) ───────────
      // Two simplex samples give an approximate surface normal direction.
      // Offsetting text UV along this normal creates a convincing liquid-lens look.
      vec2 textUV = glitchUv;
      if (uRefraction > 0.01) {
        float rSeed = uTime * 0.32;
        float rN1 = snoise(uv * 3.8 + vec2(rSeed,        rSeed * 0.77));
        float rN2 = snoise(uv * 3.8 + vec2(-rSeed * 0.77, rSeed));
        textUV += vec2(rN1, rN2) * uRefraction * 0.018;
      }

      // ── 2b. 3D perspective tilt ──────────────────────────────────────────
      // Animated homographic UV transform — tilts the "text plane" in depth.
      // tiltY rotates around the vertical axis (left-right lean),
      // tiltX rotates around the horizontal axis (forward-back lean).
      if (uPerspTilt > 0.01) {
        vec2  pc    = vec2(0.5, 0.47);
        vec2  pd    = textUV - pc;
        float tiltY = sin(uTime * 0.27 + 0.40) * uPerspTilt * 0.14;
        float tiltX = cos(uTime * 0.19 + 1.10) * uPerspTilt * 0.07;
        float pDiv  = max(0.12, 1.0 + pd.x * tiltY + pd.y * tiltX);
        textUV      = pc + pd / pDiv;
        // Subtle parallax: objects "deeper" (textUV far from center) shift more
        float depthShift = length(pd) * uPerspTilt * 0.03;
        textUV.x += sin(uTime * 0.31) * depthShift;
        textUV.y += cos(uTime * 0.23) * depthShift * 0.5;
      }
      textUV = clamp(textUV, 0., 1.);

      // ── 3. RGB chromatic aberration (applied on top of textUV) ───────────
      float rgbAmt = uRGBShift + uHigh*0.001 + uGlitch*0.004;
      vec2 rUV = clamp(textUV + vec2( rgbAmt, 0.), 0., 1.);
      vec2 gUV = textUV;
      vec2 bUV = clamp(textUV - vec2( rgbAmt, 0.), 0., 1.);

      // ── 4. Sample text texture ───────────────────────────────────────────
      float tR = texture2D(uTextTexture, rUV).r;
      float tG = texture2D(uTextTexture, gUV).g;
      float tB = texture2D(uTextTexture, bUV).b;
      float tA = texture2D(uTextTexture, gUV).a;
      vec3  textRGB = vec3(tR, tG, tB);

      // ── 5. Mood tint ─────────────────────────────────────────────────────
      vec3 tinted = mix(textRGB, uMoodColor, 0.45);

      // ── 6. Rainbow / prismatic ───────────────────────────────────────────
      if (uRainbow > 0.01) {
        float hue     = fract(uv.x * 1.6 + uTime * 0.07);
        vec3  rainbow = hsv2rgb(vec3(hue, 0.85, 1.0));
        tinted        = mix(tinted, rainbow, uRainbow * tA * 0.9);
      }

      // ── 7. Iridescent shimmer ────────────────────────────────────────────
      // Diagonal sine wave sweeps a narrow prismatic band across the text.
      // Looks like a hologram or CD surface catching light.
      if (uIridescence > 0.01) {
        float iPhase = uv.x*11.0 + uv.y*3.5 - uTime*2.2;
        float iWave  = pow(sin(iPhase)*0.5 + 0.5, 2.5);        // sharp bright bands
        float iHue   = fract(iWave*0.65 + uTime*0.045 + uv.x*0.35);
        vec3  iCol   = hsv2rgb(vec3(iHue, 0.80, 1.3));
        // Only tint where the iridescent wave overlaps text
        tinted = mix(tinted, tinted * iCol * 1.4, uIridescence * iWave * tA);
      }

      // ── 8. Beat brightness flash ─────────────────────────────────────────
      tinted = mix(tinted, vec3(1.0), uBeatPulse * 0.45 * tA);

      // ── 9. Inner glow — 8-tap radial ─────────────────────────────────────
      float glowR   = 0.0006 + uBass*0.001;
      float glowAcc = 0.;
      for(int i=0;i<8;i++){
        float ang = float(i)*0.7854;
        glowAcc  += texture2D(uTextTexture, clamp(glitchUv+vec2(cos(ang),sin(ang))*glowR,0.,1.)).a;
      }
      glowAcc /= 8.0;
      glowAcc  = pow(glowAcc, 1.6);
      vec3 innerGlow = uMoodColor * glowAcc * uGlowStrength * (0.55 + uBass*0.35);

      // ── 10. Outer aura — 12-tap soft halo ────────────────────────────────
      vec3 outerGlow = vec3(0.0);
      if (uOuterGlowMult > 0.01) {
        float outerR   = 0.0048 + uBass*0.004;
        float outerAcc = 0.;
        for(int i=0;i<12;i++){
          float ang = float(i)*0.5236;
          outerAcc += texture2D(uTextTexture, clamp(glitchUv+vec2(cos(ang),sin(ang))*outerR,0.,1.)).a;
        }
        outerAcc /= 12.0;
        outerAcc  = pow(outerAcc, 0.75);
        outerGlow  = uMoodColor * outerAcc * uGlowStrength * uOuterGlowMult * 0.28;
      }

      // ── 11. Caustic patterns ─────────────────────────────────────────────
      // Light-through-water shimmer across the whole scene.
      // Visible in dark areas, subtly tints lit areas, pulses with bass.
      vec3 causticContrib = vec3(0.0);
      if (uCaustics > 0.01) {
        vec2  cUV   = uv * 4.8 + vec2(uTime*0.14, uTime*0.10);
        float caus  = causticVal(cUV, uTime * 0.48);
        // Second offset layer for richer interference
        vec2  cUV2  = uv * 3.6 + vec2(-uTime*0.09, uTime*0.13);
        float caus2 = causticVal(cUV2, uTime * 0.38 + 1.57);
        float caustTotal = (caus + caus2 * 0.6) / 1.6;
        causticContrib = uMoodColor * caustTotal * uCaustics * 0.20;
        causticContrib += uMoodColor * caustTotal * uCaustics * uBass * 0.14; // bass pump
      }

      // ── 12. FBM displacement for feedback trails ─────────────────────────
      float noiseT  = uTime * uNoiseSpeed;
      float dispAmt = uDistortion + uBass*0.008;
      float nx = fbm(glitchUv * uNoiseFreq + vec2(noiseT, 0.0));
      float ny = fbm(glitchUv * uNoiseFreq + vec2(0.0, noiseT + 4.2));
      vec2 dispUv = glitchUv + vec2(nx, ny) * dispAmt;

      // ── 13. Feedback sample + decay ──────────────────────────────────────
      vec2 ctr     = vec2(0.5);
      vec2 feedUv  = (dispUv - ctr) / (1.0 + uBass*0.005) + ctr;
      feedUv       = clamp(feedUv, 0., 1.);
      vec4 feed    = texture2D(uFeedback, feedUv);
      float decay  = clamp(uFeedbackDecay - uHigh*0.05, 0.40, 0.90);
      feed        *= decay * (1.0 - tA*0.98);

      // ── 14. Hue drift on trail ghosts ────────────────────────────────────
      float hShift = sin(uTime*0.10)*0.04;
      feed.r += hShift*(1.0-tA);
      feed.b -= hShift*0.5*(1.0-tA);

      // ── 15. Composite ────────────────────────────────────────────────────
      vec3 composite = feed.rgb;
      composite     += causticContrib;                       // caustic ambient
      composite     += outerGlow * (1.0 - tA*0.3);
      composite     += innerGlow * (1.0 - tA*0.5);
      composite     += tinted * tA;                          // crisp text on top

      // ── 16. Beat pulse rings ─────────────────────────────────────────────
      if (uBeatPulse > 0.01) {
        float dist   = length(uv - vec2(0.5));
        float ringR  = 1.0 - uBeatPulse;
        float ringW  = 0.05 + uBeatPulse*0.02;
        float ring   = smoothstep(ringW, 0.0, abs(dist - ringR)) * uBeatPulse;
        float ring2R = clamp(1.0 - uBeatPulse*1.6, 0.0, 1.0);
        float ring2  = smoothstep(ringW*0.6, 0.0, abs(dist - ring2R)) * uBeatPulse*0.45;
        composite   += uMoodColor * (ring + ring2) * 0.65;
      }

      // ── 17. God rays ─────────────────────────────────────────────────────
      // March each pixel toward the text center.  Pixels whose ray passes
      // through text lit-regions accumulate glow — streaks radiate outward.
      if (uGodRays > 0.01) {
        vec2  lightOrigin = vec2(0.5, 0.47);
        vec2  step14      = (lightOrigin - uv) / 14.0;
        vec2  marchUV     = uv;
        float accumRay    = 0.0;
        float decayW      = 1.0;
        for (int s = 0; s < 14; s++) {
          marchUV  += step14;
          accumRay += texture2D(uTextTexture, clamp(marchUV,0.,1.)).a * decayW;
          decayW   *= 0.87;
        }
        accumRay  /= 14.0;
        // Add rays in non-text areas so they radiate visibly outward
        composite += uMoodColor * accumRay * uGodRays * 1.4 * (1.0 - tA*0.6);
        // Second tighter pass for a bright core ray
        vec2  step7   = (lightOrigin - uv) / 7.0;
        vec2  mUV2    = uv;
        float core    = 0.0;
        float dW2     = 1.0;
        for (int s = 0; s < 7; s++) {
          mUV2  += step7;
          core  += texture2D(uTextTexture, clamp(mUV2,0.,1.)).a * dW2;
          dW2   *= 0.80;
        }
        composite += uMoodColor * (core/7.0) * uGodRays * 0.6;
      }

      // ── 18. CRT scanlines ────────────────────────────────────────────────
      if (uScanlines > 0.01) {
        float scan  = sin(uv.y * 1080.0 * 1.57) * 0.5 + 0.5;
        composite  *= 1.0 - uScanlines*0.3*(1.0-scan);
      }

      // ── 19. Vignette ─────────────────────────────────────────────────────
      vec2  vig    = uv*2.-1.;
      composite   *= 1.0 - dot(vig,vig)*0.28;

      // ── 20. Film grain ───────────────────────────────────────────────────
      composite += snoise(uv*380. + vec2(uTime*120.,0.)) * 0.025;

      gl_FragColor = vec4(clamp(composite, 0., 1.), 1.0);
    }
  `,

  // ── Feedback blit ────────────────────────────────────────────────────────
  fragmentBlit: /* glsl */`
    precision highp float;
    uniform sampler2D uSource;
    varying vec2 vUv;
    void main() { gl_FragColor = texture2D(uSource, vUv); }
  `,
};

export function buildProgram(gl, vertSrc, fragSrc) {
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error('Shader compile error:\n' + gl.getShaderInfoLog(s));
    return s;
  };
  const vert = compile(gl.VERTEX_SHADER,   vertSrc);
  const frag = compile(gl.FRAGMENT_SHADER, fragSrc);
  const prog = gl.createProgram();
  gl.attachShader(prog, vert);
  gl.attachShader(prog, frag);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
    throw new Error('Program link error:\n' + gl.getProgramInfoLog(prog));
  gl.deleteShader(vert);
  gl.deleteShader(frag);
  return prog;
}
