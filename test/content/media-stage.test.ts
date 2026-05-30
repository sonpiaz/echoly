// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  captionAnchorStyles,
  clampDockToStage,
  defaultDockPosition,
  findPrimaryVideo,
} from "@/content/media-stage";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("media-stage", () => {
  it("findPrimaryVideo picks the largest visible video on generic pages", () => {
    const small = document.createElement("video");
    small.style.cssText = "width:200px;height:120px";
    const big = document.createElement("video");
    big.style.cssText = "width:800px;height:450px";
    document.body.append(small, big);
    Object.defineProperty(small, "getBoundingClientRect", {
      value: () => ({ width: 200, height: 120, left: 0, top: 0, right: 200, bottom: 120 }),
    });
    Object.defineProperty(big, "getBoundingClientRect", {
      value: () => ({ width: 800, height: 450, left: 0, top: 0, right: 800, bottom: 450 }),
    });
    expect(findPrimaryVideo()).toBe(big);
  });

  it("anchors caption above the stage bottom inset", () => {
    const rect = {
      left: 100,
      top: 50,
      right: 900,
      bottom: 550,
      width: 800,
      height: 500,
    } as DOMRect;
    Object.assign(window, { innerHeight: 600 });
    const styles = captionAnchorStyles(
      { rect, insets: { bottom: 72, top: 52, side: 20 } },
      "bottom",
    );
    expect(styles.bottom).toBe(`${600 - 550 + 72}px`);
    expect(styles.left).toBe(`${100 + 400}px`);
  });

  it("default dock sits in the stage top-right", () => {
    const rect = {
      left: 0,
      top: 0,
      right: 800,
      bottom: 450,
      width: 800,
      height: 450,
    } as DOMRect;
    const insets = { bottom: 56, top: 44, side: 16 };
    const pos = defaultDockPosition({ rect, insets });
    expect(pos.left).toBe(800 - 220 - 16);
    expect(pos.top).toBe(14);
    const clamped = clampDockToStage(pos.left, pos.top, { rect, insets: { bottom: 56, top: 44, side: 16 } });
    expect(clamped.left).toBe(pos.left);
  });
});
