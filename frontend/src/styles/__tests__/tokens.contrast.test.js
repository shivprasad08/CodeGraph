import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../../lib/contrast';

// Read from disk: Vitest does not process CSS imports by default (even ?raw)
const tokensCss = readFileSync(new URL('../tokens.css', import.meta.url), 'utf8');

// Reads the default (dark) :root block so the test checks the real token file
function readRootTokens(css) {
  const root = css.match(/:root\s*\{([\s\S]*?)\}/)[1];
  const tokens = {};
  for (const [, name, value] of root.matchAll(/--cg-([\w-]+)\s*:\s*([^;]+);/g)) {
    tokens[name] = value.trim();
  }
  return tokens;
}

const t = readRootTokens(tokensCss);
const SURFACES = ['canvas', 'raised', 'overlay'];

describe('token contrast (WCAG 2.1 AA)', () => {
  for (const text of ['text', 'text-secondary', 'text-tertiary']) {
    for (const surface of SURFACES) {
      it(`${text} on ${surface} is at least 4.5:1`, () => {
        expect(contrastRatio(t[text], t[surface])).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it('on-primary on primary is at least 4.5:1', () => {
    expect(contrastRatio(t['on-primary'], t.primary)).toBeGreaterThanOrEqual(4.5);
  });

  it('on-primary on primary-hover is at least 4.5:1', () => {
    expect(contrastRatio(t['on-primary'], t['primary-hover'])).toBeGreaterThanOrEqual(4.5);
  });

  // rgba tokens are composited over the surface before measuring
  for (const surface of SURFACES) {
    it(`border-strong on ${surface} is at least 3:1`, () => {
      expect(contrastRatio(t['border-strong'], t[surface])).toBeGreaterThanOrEqual(3);
    });

    it(`focus ring on ${surface} is at least 3:1`, () => {
      expect(contrastRatio(t.focus, t[surface])).toBeGreaterThanOrEqual(3);
    });
  }

  // Danger button: red text at rest, dark text on red when hovered
  it('sev-high text on canvas and raised is at least 4.5:1', () => {
    expect(contrastRatio(t['sev-high'], t.canvas)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(t['sev-high'], t.raised)).toBeGreaterThanOrEqual(4.5);
  });

  it('on-primary on sev-high (danger hover) is at least 4.5:1', () => {
    expect(contrastRatio(t['on-primary'], t['sev-high'])).toBeGreaterThanOrEqual(4.5);
  });
});

describe('contrastRatio helper', () => {
  it('matches the reference values for black on white', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
  });

  it('composites rgba over the background', () => {
    // 50% white over black → #808080 (~5.3:1 against black)
    expect(contrastRatio('rgba(255, 255, 255, 0.5)', '#000000')).toBeCloseTo(5.28, 1);
  });
});
