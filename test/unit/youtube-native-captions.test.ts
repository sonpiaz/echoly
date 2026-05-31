// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { suppressYouTubeNativeCaptions } from "@/platforms/youtube/native-captions";

describe("suppressYouTubeNativeCaptions", () => {
  let btn: HTMLButtonElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    btn = document.createElement("button");
    btn.className = "ytp-subtitles-button";
    btn.setAttribute("aria-pressed", "true");
    document.body.append(btn);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("clicks CC off when on and restore re-enables", () => {
    let clicks = 0;
    btn.addEventListener("click", () => {
      clicks += 1;
      const on = btn.getAttribute("aria-pressed") === "true";
      btn.setAttribute("aria-pressed", on ? "false" : "true");
    });

    const restore = suppressYouTubeNativeCaptions();
    expect(clicks).toBe(1);
    expect(btn.getAttribute("aria-pressed")).toBe("false");

    restore();
    expect(clicks).toBe(2);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
  });

  it("no-op restore when CC was already off", () => {
    btn.setAttribute("aria-pressed", "false");
    let clicks = 0;
    btn.addEventListener("click", () => {
      clicks += 1;
    });

    const restore = suppressYouTubeNativeCaptions();
    expect(clicks).toBe(0);
    restore();
    expect(clicks).toBe(0);
  });
});
