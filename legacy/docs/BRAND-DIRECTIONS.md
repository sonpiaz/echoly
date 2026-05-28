# Echoly — 3 Visual Directions

**Pick 1 by 2026-05-20.** Once locked, Claude builds Tailwind tokens + 6 components + applies to landing/dashboard/email (Day 4).

Each direction below has: name + vibe, color stops, type pairing, hero pattern, sample mockup. All three respect the locked decisions (dark-first marketing, wordmark-only logo, audio-gradient family).

---

## Direction A — **"Aurora"**

> Soft polar-light gradient. Premium-but-friendly, modern, signals multilingual blending.

### Colors
```
bg-base:    #0A0B14   (almost-black with violet undertone)
bg-elevated: #15172A
fg-primary:  #F5F5FA
fg-muted:    #9197B3
accent-1:   #7B61FF   (violet — primary accent, buttons, links)
accent-2:   #FF6BD5   (pink — gradient mid)
accent-3:   #FFAA5A   (amber — gradient end, preserves orange recall)
success:    #4ADE80
warning:    #FBBF24
error:      #F87171
```

Gradient: `linear-gradient(135deg, #7B61FF 0%, #FF6BD5 50%, #FFAA5A 100%)`

### Type
- Heading: **Geist** semibold (24-72px, tight tracking -0.02em)
- Body: Geist regular 16px, line-height 1.6
- Mono: Geist Mono

### Hero pattern
```
┌─────────────────────────────────────────────┐
│  echoly                       Sign in →    │
│                                             │
│       Translation that                      │
│       keeps up with the stream.             │
│                                             │
│       [ Get free → ] [ Watch demo ▸ ]      │
│                                             │
│   ╭───────────────────────────────────────╮ │
│   │  ░░░ Aurora gradient ░░░              │ │
│   │  YouTube player mock                  │ │
│   │  with Echoly overlay caption          │ │
│   ╰───────────────────────────────────────╯ │
└─────────────────────────────────────────────┘
```

### Vibe references
- ElevenLabs (gradient hero)
- Stripe docs dark mode
- Claude.ai landing accent

### Risk
- Trendy AI-gradient look could date in 12 months
- Pink might feel less serious for P3 power-creator persona

---

## Direction B — **"Signal"**

> Cyan + violet edge-tech. Confident, less warm. Skews more developer-tool than learner-tool.

### Colors
```
bg-base:    #07090F
bg-elevated: #11141C
fg-primary:  #E8ECF5
fg-muted:    #7C8499
accent-1:   #06B6D4   (cyan — primary)
accent-2:   #6366F1   (indigo — gradient mid)
accent-3:   #A855F7   (violet — gradient end)
success:    #34D399
warning:    #F59E0B
error:      #F43F5E
```

Gradient: `linear-gradient(135deg, #06B6D4 0%, #6366F1 50%, #A855F7 100%)`

### Type
- Heading: **Geist** semibold OR **Inter** bold (both tested for VN diacritic)
- Body: Inter / Geist 16px
- Mono: JetBrains Mono

### Hero pattern
```
┌─────────────────────────────────────────────┐
│  echoly·                      Sign in →    │
│  (dot after wordmark = signal "live")      │
│                                             │
│       Watch any video.                      │
│       Hear it in yours.                     │
│                                             │
│  ▰▰▰▰▰▰▰░░░░░ live audio waveform anim     │
│                                             │
│       [ Get free ]                          │
└─────────────────────────────────────────────┘
```

### Vibe references
- Linear (color & spacing rigor)
- Cursor (gradient + dev energy)
- Vercel (clean minimal)

### Risk
- Cold for the language-learner persona (Trang)
- "Yet another cyan+violet dev-tool" — many tools look like this in 2026

---

## Direction C — **"Subtitle"**

> Editorial-serif HEADING contrasted with sans body. Sound waves as small motif. Dark-first but warmer. Echoly = the elegant utility.

### Colors
```
bg-base:    #0F1015   (warm near-black)
bg-elevated: #1A1C26
fg-primary:  #FAFAF7  (slight cream)
fg-muted:    #9A9CA7
accent-1:   #F472B6   (rose — primary accent, restrained use)
accent-2:   #FB923C   (amber — gradient pair, preserves orange thread)
accent-warm: #FCD34D  (warm gold — sparse highlight)
success:    #86EFAC
warning:    #FCD34D
error:      #FCA5A5
```

Gradient: `linear-gradient(135deg, #F472B6 0%, #FB923C 100%)` (2-stop, calmer)

### Type
- Heading: **Söhne / Times / Editorial New** (serif) for h1/h2 — premium feel
- Body: **Geist** sans 16px
- Mono: Geist Mono

### Hero pattern
```
┌─────────────────────────────────────────────┐
│  echoly                       Sign in →    │
│                                             │
│   ╭─ EDITORIAL SERIF (large) ─╮             │
│   │ Subtitle done.            │             │
│   │ Live, in your language.   │             │
│   ╰────────────────────────────╯            │
│                                             │
│   sans 16px subtext explaining product      │
│                                             │
│   [ Get free → ]                            │
│                                             │
│   ··· small sound-wave motif ···            │
└─────────────────────────────────────────────┘
```

### Vibe references
- Resend (dark + editorial serif heading)
- The Browser Company / Arc (warm minimal)
- Anthropic Claude docs (restrained)

### Risk
- Serif headings polarize — some users read "editorial = old"
- More design craft required to execute well (small font choice errors loud)
- Söhne is paid license (~$200) if we commit

---

## How to pick

Ask yourself: when "Trang" (Persona P1, the Regular Learner ICP) lands on `echolyhq.com`, which direction makes her go *"this looks like a tool I'd pay $9 for"* without thinking about why?

| Direction | Trang's gut reaction (Claude's prediction) |
|---|---|
| **A — Aurora** | "Modern, friendly. Like Notion." → likely pay |
| **B — Signal** | "Looks technical. Maybe too dev-y for what I need." → bounce 20% |
| **C — Subtitle** | "Feels expensive but I trust it." → premium-tier signal |

Claude's lean: **A (Aurora)** as default — broadest persona coverage, preserves a thread of the orange that's already on the extension button. C as second choice if Son wants premium-elegant. B if Son wants edge-tech.

---

## Once locked

Claude proceeds with:
1. Tailwind config (`echoly-web/tailwind.config.ts`) with chosen tokens
2. CSS variables for both dark-first marketing + extension light surface
3. 6 reusable React components (Astro-compatible):
   - `<Button>` (primary/secondary/ghost)
   - `<Input>` (text + email)
   - `<Card>`
   - `<PricingCard>`
   - `<UsageMeter>` (animated bar with cap label)
   - `<EmailLayout>` (React Email wrapper for all transactional)
4. Wordmark SVG (3 micro-variants to pick from once direction is locked)
5. Apply to: landing hero, pricing section, signin form, account dashboard, welcome_paid email

ETA from "Son picks direction" → "landing renders with brand applied" = **same day** (~4-6h Claude work).
