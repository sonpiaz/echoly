// Regression guard: the content overlay host `.ec-root` must NOT be a
// full-viewport box. A full-viewport `position:fixed` root with backdrop-filter
// children promotes a full-screen compositor surface on YouTube → a dark scrim
// over the whole page on Start. The host must stay zero-sized; every child is
// position:fixed + JS-anchored. jsdom can't compute CSS, so this is a static
// assertion on the overlay.css `.ec-root` rule. (SOLUTION ext-overlay-tier-fixes AC1.)

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CSS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/content/overlay/overlay.css",
);

/** Extract the first `.ec-root { ... }` block (not the `.ec-root[...]`/`.ec-root >`
 *  variants — match the bare selector followed by `{`). */
function ecRootBlock(css: string): string {
  const m = /(^|\n)\.ec-root\s*\{([^}]*)\}/.exec(css);
  if (!m) throw new Error(".ec-root rule not found in overlay.css");
  return m[2] ?? "";
}

describe("overlay.css .ec-root — no full-viewport host", () => {
  const css = readFileSync(CSS_PATH, "utf8");
  const block = ecRootBlock(css);

  it("does NOT use inset:0 (would make it full-viewport)", () => {
    expect(block).not.toMatch(/inset\s*:\s*0/);
  });

  it("is collapsed to zero size (width:0 + height:0)", () => {
    expect(block).toMatch(/width\s*:\s*0\b/);
    expect(block).toMatch(/height\s*:\s*0\b/);
  });

  it("keeps position:fixed, overflow:visible, pointer-events:none", () => {
    expect(block).toMatch(/position\s*:\s*fixed/);
    expect(block).toMatch(/overflow\s*:\s*visible/);
    expect(block).toMatch(/pointer-events\s*:\s*none/);
  });

  it("keeps the high z-index so the dock/captions stay above page chrome", () => {
    expect(block).toMatch(/z-index\s*:\s*2147483600/);
  });

  it("does NOT establish a containing block for fixed children (no transform/filter/contain/will-change/perspective)", () => {
    // These props on .ec-root would re-anchor its position:fixed children to the
    // (now 0×0) root box, breaking dock/caption positioning.
    expect(block).not.toMatch(/(^|\s)(transform|filter|backdrop-filter|contain|will-change|perspective)\s*:/);
  });
});
