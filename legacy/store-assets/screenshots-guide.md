# Echoly — Screenshot capture guide

Web Store needs **5 screenshots** at **1280×800** OR **640×400** (PNG, no alpha). Use the bigger size — Web Store auto-resizes; bigger looks crisper on the listing.

Tool: macOS `Cmd+Shift+4` then drag a 1280×800 region. Or use CleanShot / Kap and pick a custom size. Output `~/echoly/store-assets/screenshots/01-popup-idle.png`, `02-popup-running.png`, etc.

## The 5 screenshots

### 01 — Popup idle, ready to start
- Open any YouTube video in the background (e.g., a TED talk thumbnail visible).
- Click Echoly icon. Popup is in `idle` state, key already saved.
- Capture popup + a strip of the YouTube video behind it for context.
- Sells: clean UI, "saved" badge, two-tier dropdown visible, Start button highlighted.

### 02 — In-page panel translating live (HERO shot)
- Start a Realtime session on an English video, target Vietnamese, voice Marin.
- Wait until the panel's main area shows ~2 lines of Vietnamese text and the status pill says "Translating".
- Capture full browser at 1280×800 with the panel + a healthy slice of the YouTube player visible.
- This is the money shot — make sure the dub text is meaningful and looks like a real translation, not a half-formed phrase.

### 03 — Standard tier active with source captions on
- Switch to Standard tier in popup, voice Captivating Female, language Vietnamese, toggle "Show source captions" ON.
- Start. Wait until both the source caption (English) and the dub (Vietnamese) are populated.
- Capture the panel showing both — proves the side-by-side mode works.

### 04 — Translation history view
- Let a session run for ~2 minutes so 5-8 history entries accumulate.
- Resize the panel a bit wider so the history sidebar is fully visible.
- Capture — shows the "rewind" feature, useful for users who missed a sentence.

### 05 — Voice picker open
- Click the voice dropdown in the panel. Capture with the dropdown expanded showing all 5 (Standard) or 9+Auto (Realtime) voices.
- Shows depth of options, multilingual support implied via voice variety.

## Composition tips
- YouTube player on the left, Echoly panel on the right — natural English reading flow.
- Target the same video in all 5 shots so the listing feels coherent. Suggestion: a recent Apple keynote or a TED talk (English narrator, clear speech, recognizable thumbnail).
- Keep the YouTube UI clean — pause the video at a non-distracting frame, hide the YT controls (mouse-out for 3s), close any popups.
- After capture, run through `pngcrush` or just leave as-is — Web Store doesn't care about file size as long as <16 MB each.

## Optional screenshot 06 — Cosy mode
If you want a 6th, a "media kit" style shot: Echoly icon + brand wordmark on a flat orange-to-black gradient. Helps social media reuse, not needed for the Web Store form.

---

## Promo tile (separate field)

Web Store wants a **440×280 PNG** "Small promo tile" used in search results.

Easiest: I'll generate one for you in the next step. Spec: Echoly wordmark + the SVG mark at 80×80 + tagline "Live YouTube translation, in your language" on a brand-orange→black gradient. ~30 sec to render.

You can also do this in Figma in 5 min if you want full control over typography.
