/**
 * KeywordTriggers
 * ---------------
 * Scans lyric lines for specific semantic keywords and returns
 * a trigger object that activates special shader effects.
 *
 * Each category maps to a visual "mode" modifier passed as a uniform.
 */
export class KeywordTriggers {
  constructor() {
    this.rules = [
      {
        name:     'fire',
        keywords: ['fire', 'burn', 'burning', 'flame', 'flames', 'blaze', 'ignite', 'inferno', 'heat'],
        effect:   { glitch: 0.3, heatDistort: 1.0, colorMode: 'fire' },
      },
      {
        name:     'water',
        keywords: ['rain', 'ocean', 'river', 'wave', 'waves', 'flood', 'drown', 'drowning', 'water', 'sea', 'tears', 'liquid'],
        effect:   { waterRipple: 1.0, colorMode: 'water' },
      },
      {
        name:     'space',
        keywords: ['space', 'stars', 'galaxy', 'cosmos', 'infinite', 'void', 'universe', 'orbit', 'sky', 'heaven', 'cosmos'],
        effect:   { bloom: 1.5, particles: 1.0, colorMode: 'space' },
      },
      {
        name:     'glitch',
        keywords: ['break', 'broken', 'shatter', 'crash', 'corrupt', 'error', 'static', 'chaos', 'destroy', 'digital'],
        effect:   { glitch: 1.0, rgbSplit: 0.03, colorMode: 'glitch' },
      },
      {
        name:     'pulse',
        keywords: ['heart', 'pulse', 'beat', 'breath', 'breathe', 'alive', 'blood', 'feel', 'feeling'],
        effect:   { pulse: 1.0, colorMode: 'pulse' },
      },
      {
        name:     'euphoria',
        keywords: ['euphoria', 'euphoric', 'ecstasy', 'paradise', 'heaven', 'bliss', 'soar', 'fly', 'freedom'],
        effect:   { bloom: 2.0, colorMode: 'euphoria' },
      },
    ];

    // Active effects decay
    this._active = {};
  }

  /**
   * Scan a lyric line and return all triggered effects merged.
   * @param {string} line
   * @returns {Object} merged effect object
   */
  check(line) {
    const words   = line.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/);
    const wordSet = new Set(words);

    const triggered = [];
    for (const rule of this.rules) {
      if (rule.keywords.some(kw => wordSet.has(kw))) {
        triggered.push(rule);
      }
    }

    if (!triggered.length) return {};

    // Merge all triggered effects
    const merged = {};
    for (const t of triggered) {
      Object.assign(merged, t.effect);
    }

    console.log('[Keywords] Triggered:', triggered.map(t => t.name).join(', '));
    return merged;
  }

  /**
   * Return a list of matched category names for a line.
   */
  matchCategories(line) {
    const words   = line.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/);
    const wordSet = new Set(words);
    return this.rules
      .filter(r => r.keywords.some(kw => wordSet.has(kw)))
      .map(r => r.name);
  }
}
