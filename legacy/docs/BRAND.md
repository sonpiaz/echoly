# Echoly — Brand Brief v0.1

**Status**: Draft 2026-05-19 — Son to review/approve. Once locked, this drives every visual decision (logo, color, type, motion, voice) across landing, dashboard, extension, email, and Stripe surfaces.

**Owner**: Son (Affitor LLC).
**Sister docs**: `SPEC-SUBSCRIPTION.md` (product), `BRAND.md` (this — visual + voice).

---

## 1. Positioning

**For** software developers, language learners, and content creators who watch English-language videos and need instant comprehension or repurposing,
**Echoly is** a translation-and-comprehension layer that lives inside the YouTube player,
**that** turns any video into your language with sub-second subtitle-first translation and optional realtime audio overlay,
**unlike** Google Translate (only text), DeepL (no video integration), Notta/Otter (transcription only, no live overlay), or browser auto-translate (low quality, no audio).

**One-liner candidates** (pick 1 by Day 4):
- *"Watch any video. Hear it in yours."*
- *"Subtitle done. Live, in your language."*
- *"Translation that keeps up with the stream."*

## 2. Personas (3 — priority order)

### P1 — "Trang" — the Regular Learner *(ICP — Pro tier, main paying base)*
- 23, Vietnamese, mid-level software developer at a SG-based fintech
- Watches 5-15h/month: tech talks, podcasts, YouTube tutorials in English
- Pain: subtitles when present are lazy/wrong; pausing-rewinding kills flow
- Tech-fluent but doesn't want to fiddle with APIs/BYOK
- Pays $9-15/mo for tools that save time (Raycast, Notion, Granola already paying)
- Brand cue: "set-and-forget", premium-but-affordable, professional-not-corporate

### P2 — "Marco" — the Curious Casual *(Free tier — top-of-funnel)*
- 19, Italian undergrad, learning multiple languages
- Watches 1-2 EN/VN videos a week mixed with native content
- Pain: doesn't want commitment; needs a "no signup required" first hit
- Will upgrade IF the free taste is good
- Brand cue: friendly, low-friction, multilingual flag-y vibe

### P3 — "Hùng" — the Power Creator *(Max tier — high-margin)*
- 31, Vietnamese livestream marketer + podcast host
- Translates content for repurposing + does live realtime translation during streams
- Spends $50-100/mo on creator tools
- Pain: existing tools batch-process (slow); needs realtime
- Brand cue: serious, fast, capable, "broadcast-grade"

## 3. Brand personality (5 adjectives — filter for every decision)

1. **Fast** — sub-second response is the product. Visual cues: motion, momentum, no skeleton-flicker UX
2. **Multilingual-native** — not English-first with translation bolted on; equal weight to VN, EN, ES, JA, etc.
3. **Premium-but-accessible** — looks like a $19/mo tool, but $9 to start. Linear/Granola vibe, NOT Apple/$200/mo enterprise
4. **Confident-not-flashy** — no anime sparkles, no AI-slop gradients. Quietly impressive
5. **Friendly-to-creators** — extensions live in a YouTube player; we respect the host UI, never fight it

**Anti-personality** (what we're not):
- ❌ Cute/playful mascot (no orange fox, no robot face)
- ❌ Corporate-saas-blue (Salesforce/Stripe-blue)
- ❌ AI-slop rainbow gradients with stars
- ❌ Vietnamese-folk motif (lotus, conical hat, áo dài) — global-first market

## 4. Voice & tone

| Surface | Tone | Example |
|---|---|---|
| Landing hero | Confident statement, no clickbait | *"Translation that keeps up with the stream."* |
| Dashboard | Functional + terse | *"You've used 14 of 25 hours."* (not *"Wow, you're crushing it! 🎉"*) |
| Email — welcome | Warm + brief + signed-by-Son | *"Hi Trang — Echoly Pro is live. Three quick tips below."* |
| Email — payment failed | Direct, no shame | *"Your last payment didn't go through. Update card to keep Echoly active."* |
| Extension overlay | Invisible until needed | Status text in YT player font, no extra branding inside the player |
| Error message | Honest + solution | *"YouTube changed its player markup. We're fixing it — track at status.echolyhq.com"* |

**Language registers**:
- English: clean, no jargon, no "leverage / utilize / robust". Use Stripe-doc-tone.
- Vietnamese: "bạn" not "anh/chị", informal-professional. Avoid English loanwords when a clean VN word exists.

## 5. Direct competitive landscape (study these UIs)

| Brand | Surface to study | What to borrow / avoid |
|---|---|---|
| **ElevenLabs** | landing + product | Audio-gradient, dark-first, waveform motif — **borrow vibe** |
| **Linear** | dashboard + email | Type-driven minimal — **borrow design system rigor** |
| **Granola** | onboarding + product | Warm minimal, meeting-tool — **borrow content-tone**, avoid the cream beige |
| **Resend** | docs + email | Dark + editorial serif heading — **borrow heading typography** |
| **Cursor** | landing hero | Gradient + motion + dev-tool premium — **borrow hero pattern** |
| **Notta / Otter** | full UI | Direct comp — **study what they do, do less** (their UIs are bloated) |
| **DeepL** | translation UX | Source-target language pair display — **borrow UI for language picker** |

## 6. Visual direction — 3 candidates

**Decision locked 2026-05-19** (Son):
- ✅ FAST approach (Claude drafts, Son reviews)
- ✅ Audio-gradient color direction (replaces orange #FF6B35)
- Dark-first marketing surfaces (landing, dashboard, email)
- Light-friendly extension popup (matches YouTube light default)

Mockups + concrete tokens follow in `BRAND-DIRECTIONS.md` (next doc — Claude generates 3 SVG concepts + Tailwind config snippet each, Son picks one).

## 7. Logo direction

v1 = **wordmark only** (no symbol). Reasons:
- Faster to ship Day 4
- Doesn't lock us into a symbol before product matures
- Wordmarks scale cleanly (32px favicon → giant landing hero)

Symbol consideration → v2 (post-launch, after 100 paying customers): possibly a sound-wave dot, speech-bubble, or letter monogram. Defer.

Typeface choice gates the wordmark. See §8.

## 8. Typography

**Requirements**:
- Full Vietnamese diacritic support (ấ, ầ, ẫ, ặ, đ, etc. — TEST in fly-fonts.com or font sample)
- Variable weight (regular / medium / semibold / bold)
- Modern grotesque sans (signals tech, not editorial)
- Mono companion for usage stats / API examples

**Shortlist**:
- `Geist` (Vercel — best VN support + modern) — **lean toward this**
- `Inter` (workhorse, ubiquitous — borderline overused)
- `Söhne` (premium feel, but $$$ license)
- `Satoshi` (free, modern, decent VN support)

**Mono**: `Geist Mono` or `JetBrains Mono`.

## 9. Motion & micro-interactions

- **Hero**: gradient drift (slow, ambient — never strobing)
- **Usage meter**: count-up animation on dashboard load (200-400ms ease-out)
- **Button**: 100ms scale + bg-darken on press
- **Page transitions**: none (instant). We're a utility, not a portfolio
- **No bouncy springs** (anti-personality #1)
- **No confetti** on subscribe — premium tools don't shout

## 10. Surfaces inventory (brand applied to all)

| Surface | Status | Priority |
|---|---|---|
| Chrome extension popup | Ships v0.5.2 (current orange button) — needs token swap Day 4-5 | P1 |
| Extension overlay on YouTube | Invisible-by-design; no branding inside player | P0 |
| Landing `echolyhq.com` | Day 4 build with locked brand | P1 |
| Dashboard `app.echolyhq.com` | Day 4 build | P1 |
| Email templates | All placeholder currently — Day 4 React Email rebuild | P1 |
| Stripe Checkout/Portal | Logo uploaded 2026-05-19 ✅; will update if logo changes | P2 |
| Support email signature | Day 4 | P3 |
| Social profile pics (FB, X, Reddit) | Day 5 launch | P2 |
| Loading screens / 404 | Day 5 polish | P3 |

## 11. Decision log

| Date | Decision | Locked by |
|---|---|---|
| 2026-05-19 | FAST brand approach (no agency v1) | Son |
| 2026-05-19 | Drop orange #FF6B35 brand color; explore audio gradient | Son |
| 2026-05-19 | Wordmark-only logo for v1; defer symbol to v2 | Claude proposed |
| 2026-05-19 | Dark-first marketing surfaces; light-friendly extension | Claude proposed |
| 2026-05-19 | Geist as candidate typeface (pending Son confirm) | Claude proposed |
| 2026-05-19 | Tool stack: Claude Code (UI/UX/components/email/landing) + Recraft v4 vector via **kyma-api default endpoint** (kyma-api already integrates Recraft V4 — uses `model: "recraft-v4-vector"` for true SVG, `recraft-v4-pro` for raster). $0 extra subscription. No Midjourney/Fiverr/agency for v1. | Son |
| 2026-05-19 | Visual direction **A "Aurora"** locked — violet/pink/amber gradient, Geist typography, dark-first marketing surfaces. | Son |
| 2026-05-19 | Landing page (`echoly-web`) — Claude owns both visual design and code (Astro + Tailwind). Son reviews at 3 milestones: wordmark pick, landing first draft, pre-launch audit. | Son |
| 2026-05-19 | **Wordmark Variant C "Gradient E" locked**: first letter `e` in Aurora gradient, rest white. Paired with 24px app-icon square (Aurora gradient bg, white `e`) for nav/dashboard/favicon. Favicon SVG at `echoly-web/public/favicon.svg`. | Son |
| 2026-05-19 | **Pivot from dark-first → Mixed sections (Stripe + ElevenLabs pattern)**. Hero, pricing, FAQ, footer = light surfaces. Features, product demo blocks, code/details, stats, bottom CTA = dark surfaces. Player mockup always dark regardless of section bg. Aurora orb adapts: vibrant on dark, soft pastel on light. CTA primary inverts: white-on-dark in dark sections, black-on-white in light sections. | Son |
| 2026-05-19 | Quality bar: Echoly v1 must visually equal Resend.com / Linear.app / Granola.ai / ElevenLabs.io anchors — iterate before launch if below. | Claude proposed |
| 2026-05-19 | Anti-pattern reject list: no AI rainbow gradients, no AI human faces, no isometric illust, no sparkle accents, no inconsistent icon stroke. | Claude proposed |

---

**Next deliverable**: `BRAND-DIRECTIONS.md` — 3 concrete visual directions with color hex stops, Tailwind config snippet, hero mockup ASCII, ready for Son to pick within 24h.
