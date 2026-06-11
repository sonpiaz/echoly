// Static CSS contract test — readFileSync + regex pattern assertions for the
// overlay drag fast-path and launcher redesign CSS.  No DOM / layout engine
// needed; we assert the rules exist at the source level so they cannot be
// silently deleted.  Pattern: copy of overlay-root-no-fullscreen.test.ts.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CSS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/content/overlay/overlay.css",
);

const css = readFileSync(CSS_PATH, "utf8");

// ── 1. .ec-dragging transition suppression ────────────────────────────────────
describe("overlay.css — .ec-dragging transition suppression (A1)", () => {
  it("has a compound .ec-dock.ec-dragging, .ec-panel.ec-dragging rule with transition: none", () => {
    // The compound selector wins specificity over the base dock/panel rules.
    expect(css).toMatch(/\.ec-dock\.ec-dragging[^{]*,\s*\n?\s*\.ec-panel\.ec-dragging\s*\{[^}]*transition\s*:\s*none/s);
  });

  it("the rule is a compound selector (not a descendant selector)", () => {
    // Must be `.ec-dock.ec-dragging` (no space between), not `.ec-dock .ec-dragging`.
    expect(css).toMatch(/\.ec-dock\.ec-dragging/);
    expect(css).toMatch(/\.ec-panel\.ec-dragging/);
  });
});

// ── 2. Base dock / panel rules retain their left/top transitions ──────────────
describe("overlay.css — base dock/panel transitions survive (non-drag re-anchoring)", () => {
  it(".ec-dock base rule has a left transition", () => {
    // The base `.ec-dock { ... transition: left ... }` must remain intact
    // for non-drag stage re-anchoring (resize, fullscreen, SPA layout shifts).
    const dockBlock = /(^|\n)\.ec-dock\s*\{([^}]*)\}/.exec(css);
    expect(dockBlock).not.toBeNull();
    expect(dockBlock![2]).toMatch(/transition/);
    expect(dockBlock![2]).toMatch(/left/);
  });

  it(".ec-panel base rule has a left transition", () => {
    const panelBlock = /(^|\n)\.ec-panel\s*\{([^}]*)\}/.exec(css);
    expect(panelBlock).not.toBeNull();
    expect(panelBlock![2]).toMatch(/transition/);
    expect(panelBlock![2]).toMatch(/left/);
  });
});

// ── 3. .ec-launcher-mark is a compact fixed-size docked tab ───────────────────
describe("overlay.css — launcher-mark compact docked-tab sizing", () => {
  it(".ec-launcher-mark has a fixed compact width (42px)", () => {
    // Extract the .ec-launcher-mark rule block.
    const markBlock = /(^|\n)\.ec-launcher-mark\s*\{([^}]*)\}/.exec(css);
    expect(markBlock).not.toBeNull();
    expect(markBlock![2]).toMatch(/width\s*:\s*42px/);
  });

  it(".ec-launcher-mark has a fixed compact height (46px)", () => {
    const markBlock = /(^|\n)\.ec-launcher-mark\s*\{([^}]*)\}/.exec(css);
    expect(markBlock).not.toBeNull();
    expect(markBlock![2]).toMatch(/height\s*:\s*46px/);
  });

  it("the mark icon is sized for visual balance (20px)", () => {
    const svgBlock = /\.ec-launcher-mark\s+svg\s*\{([^}]*)\}/s.exec(css);
    expect(svgBlock).not.toBeNull();
    expect(svgBlock![1]).toMatch(/width\s*:\s*20px/);
    expect(svgBlock![1]).toMatch(/height\s*:\s*20px/);
  });

  it(".ec-launcher-mark is shaped as a docked tab (left corners rounded, right edge flush)", () => {
    const markBlock = /(^|\n)\.ec-launcher-mark\s*\{([^}]*)\}/.exec(css);
    const block: string = markBlock![2] ?? "";
    // border-radius: <r> 0 0 <r> — square right corners against the viewport edge.
    expect(block).toMatch(/border-radius\s*:\s*\d+px\s+0\s+0\s+\d+px/);
    expect(block).toMatch(/border-right\s*:\s*none/);
  });

  it(".ec-launcher button extends a transparent click halo (padding, right edge stays 0)", () => {
    const launcherBlock = /(^|\n)\.ec-launcher\s*\{([^}]*)\}/s.exec(css);
    expect(launcherBlock).not.toBeNull();
    // padding: <top> 0 <bottom> <left> — no right padding, mark stays flush.
    expect(launcherBlock![2]).toMatch(/padding\s*:\s*\d+px\s+0\s+\d+px\s+\d+px/);
  });

  it("launcher entrance animations use `backwards` fill (filling forever would pin keyframe styles over hover/inline)", () => {
    const launcherBlock = /(^|\n)\.ec-launcher\s*\{([^}]*)\}/s.exec(css);
    const markBlock = /(^|\n)\.ec-launcher-mark\s*\{([^}]*)\}/s.exec(css);
    expect(launcherBlock![2]).toMatch(/animation\s*:[^;]*backwards/);
    expect(markBlock![2]).toMatch(/animation\s*:[^;]*backwards/);
    expect(launcherBlock![2]).not.toMatch(/animation\s*:[^;]*(?:\bboth\b|forwards)/);
    expect(markBlock![2]).not.toMatch(/animation\s*:[^;]*(?:\bboth\b|forwards)/);
  });
});

// ── 4. :focus-visible outline on .ec-launcher ────────────────────────────────
describe("overlay.css — launcher focus-visible ring (B3)", () => {
  it(".ec-launcher:focus-visible has an outline rule", () => {
    expect(css).toMatch(/\.ec-launcher:focus-visible\s*\{[^}]*outline\s*:/s);
  });

  it("the focus-visible outline uses the brand color #FF7A3C", () => {
    const block = /\.ec-launcher:focus-visible\s*\{([^}]*)\}/s.exec(css);
    expect(block).not.toBeNull();
    expect(block![1]).toMatch(/#FF7A3C/i);
  });
});

// ── 5. @keyframes ec-launcher-in targets .ec-launcher-mark, NOT .ec-launcher ─
describe("overlay.css — entrance animation on mark only (B3)", () => {
  it("@keyframes ec-launcher-in exists", () => {
    expect(css).toMatch(/@keyframes\s+ec-launcher-in\b/);
  });

  it("ec-launcher-in is applied to .ec-launcher-mark (animation property)", () => {
    const markBlock = /(^|\n)\.ec-launcher-mark\s*\{([^}]*)\}/s.exec(css);
    expect(markBlock).not.toBeNull();
    expect(markBlock![2]).toMatch(/animation\s*:.*ec-launcher-in/);
  });

  it("the button .ec-launcher does NOT use ec-launcher-in as a transform animation (avoids overriding inline translateY)", () => {
    // .ec-launcher may have an opacity-only animation but must NOT apply
    // ec-launcher-in (which has translateX) — that would override translateY(-50%).
    const launcherBlock = /(^|\n)\.ec-launcher\s*\{([^}]*)\}/s.exec(css);
    expect(launcherBlock).not.toBeNull();
    // The main .ec-launcher block must NOT reference ec-launcher-in
    // (the mark's keyframe name).
    expect(launcherBlock![2]).not.toMatch(/ec-launcher-in[^-]/);
  });
});

// ── 6. Reduced-motion block explicitly lists .ec-launcher and .ec-launcher-mark ─
// Extract everything from the @media rule opening brace to the final closing brace
// of the file (the media block is always the last rule). We can also just assert
// the pattern exists after the @media line in the CSS.
function extractReducedMotionBlock(cssText: string): string {
  const start = cssText.indexOf("@media (prefers-reduced-motion");
  if (start === -1) return "";
  // Find the opening brace after the @media line.
  const openBrace = cssText.indexOf("{", start);
  if (openBrace === -1) return "";
  // Walk forward counting braces to find the matching closing brace.
  let depth = 0;
  let i = openBrace;
  while (i < cssText.length) {
    if (cssText[i] === "{") depth++;
    else if (cssText[i] === "}") {
      depth--;
      if (depth === 0) return cssText.slice(openBrace + 1, i);
    }
    i++;
  }
  return cssText.slice(openBrace + 1);
}

describe("overlay.css — reduced-motion launcher entries (B3)", () => {
  const rmBlock = extractReducedMotionBlock(css);

  it("@media (prefers-reduced-motion: reduce) block is non-empty", () => {
    expect(rmBlock.length).toBeGreaterThan(0);
  });

  it("@media (prefers-reduced-motion: reduce) block lists .ec-launcher", () => {
    expect(rmBlock).toMatch(/\.ec-launcher[,\s{]/);
  });

  it("@media (prefers-reduced-motion: reduce) block lists .ec-launcher-mark", () => {
    expect(rmBlock).toMatch(/\.ec-launcher-mark/);
  });

  it("@media (prefers-reduced-motion: reduce) block lists .ec-launcher-label", () => {
    expect(rmBlock).toMatch(/\.ec-launcher-label/);
  });
});

// ── 7. .ec-launcher-label positioning and pointer-events ─────────────────────
describe("overlay.css — launcher label chip (B3)", () => {
  it(".ec-launcher-label has right: calc(100% + 8px)", () => {
    const labelBlock = /(^|\n)\.ec-launcher-label\s*\{([^}]*)\}/s.exec(css);
    expect(labelBlock).not.toBeNull();
    expect(labelBlock![2]).toMatch(/right\s*:\s*calc\(100%\s*\+\s*8px\)/);
  });

  it(".ec-launcher-label has pointer-events: none", () => {
    const labelBlock = /(^|\n)\.ec-launcher-label\s*\{([^}]*)\}/s.exec(css);
    expect(labelBlock).not.toBeNull();
    expect(labelBlock![2]).toMatch(/pointer-events\s*:\s*none/);
  });

  it(".ec-launcher-label is revealed on hover (opacity: 1)", () => {
    // The hover+focus-visible rule uses a comma selector; match either form.
    expect(css).toMatch(/\.ec-launcher:hover\s+\.ec-launcher-label/);
    // The combined selector block must contain opacity: 1.
    const block = /\.ec-launcher:hover\s+\.ec-launcher-label[^{]*\{([\s\S]*?)\}/.exec(css);
    expect(block).not.toBeNull();
    expect(block![1]).toMatch(/opacity\s*:\s*1/);
  });

  it(".ec-launcher-label is hidden while dragging (.ec-launcher-dragging)", () => {
    expect(css).toMatch(/\.ec-launcher-dragging\s+\.ec-launcher-label\s*\{[^}]*opacity\s*:\s*0/s);
  });
});
