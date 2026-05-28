# Echoly Subscription System — SPEC v1.0

**Status**: Draft, ready for implementation
**Authored**: 2026-05-17 (Sun)
**Owner**: Son (Affitor LLC)
**Stack**: Cloudflare Workers + D1 + Better-Auth + Stripe (Affitor LLC account) + Affitor affiliate API
**Target ship**: 5-day sprint, soft launch via Cơm AI Lò

---

## 0. Decisions locked (do NOT re-litigate)

- Echoly = brand under Affitor LLC. No separate legal entity. Shares EIN with Affitor + Kyma.
- Stripe: **dedicated Stripe account for Echoly under Affitor LLC EIN** (same pattern as Kyma-api). Separate dashboard, separate webhook endpoint, separate payouts → clean revenue tracking + easier intercompany accounting + Affitor-as-affiliate treats Echoly as just another merchant client.
- Primary domain: `echolyhq.com` (registered 2026-05-17 via Namecheap, 2-year term).
- 3 tiers: Free / Pro / Max. No Ultra tier.
- Pricing: Pro $9 monthly / $89 annual (saves 18%). Max $19 monthly / $159 annual (saves 30%).
- FUP enforcement: **hard-block** at 100% cap. No overage, no auto-top-up in v1.
- Affiliate default 25% first payment + 10% recurring. Top performer 30% + 12%.
- BYOK Kyma key remains free forever as escape hatch / privacy tier.

---

## 1. Product overview

### 1.1 What Echoly is

A Chrome MV3 extension that translates YouTube video audio into the viewer's native language in real time. Users can sign in to a subscription that bundles all required AI model costs (Kyma-mediated STT, translation, TTS), or stay in BYOK mode and pay Kyma directly.

### 1.2 Why subscription now (problem statement)

New user installs the extension, opens the popup, sees "paste Kyma key" → has no idea what Kyma is → drop-off ~95%. A subscription tier removes the BYOK friction: user pays Echoly once, dub works immediately.

### 1.3 Three target user segments

1. **Curious / casual** (free tier): student watches 1-2 English videos/week, wants to try without commitment. Either BYOK if technical, or 30-min/mo free trial if not.
2. **Regular learner** (Pro): software dev / language learner / podcast listener doing 5-15 hours/mo. Wants set-and-forget.
3. **Power user / pro** (Max): creator transcribing for content, researcher consuming long talks, anyone wanting Realtime tier for live streams.

---

## 2. Pricing tiers (full feature matrix)

### 2.1 Tier comparison

| Feature | Free | Pro | Max |
|---|---|---|---|
| **Price monthly** | $0 | $9 | $24.90 |
| **Price annual** | $0 | $89 (saves 18%) | $199 (saves 33%) |
| **Standard mode** | 30 min/mo | Unlimited (FUP 10h/mo) | Unlimited (FUP 50h/mo) |
| **Realtime mode** | BYOK only | BYOK only | 2h/mo included + BYOK |
| **Target languages** | Vi + En only | All 13 | All 13 |
| **MiniMax voices** | 2 (default) | All 5 | All 5 + experimental |
| **Voice cloning (future)** | No | No | Yes (beta) |
| **BYOK Kyma key** | Yes (unlimited) | Yes (overrides server) | Yes (overrides server) |
| **Web dashboard** | Read-only usage | Full | Full |
| **Email support** | Community only | Yes | Priority |
| **Sessions concurrent** | 1 | 2 | 3 |
| **Session max length** | 60 min | 60 min | 60 min |

### 2.2 Annual discount rationale

| Tier | Monthly × 12 | Annual price | Saves $ | Saves % |
|---|---|---|---|---|
| Pro | $108 | $89 | $19 | 17.6% |
| Max | $298.80 | $199 | $99.80 | 33.4% |

Repriced 2026-05-19 (Max $19→$24.90 monthly, $159→$199 annual). Asymmetric discount (Pro 18% vs Max 33%) creates affiliate alignment: Max annual = $49.75 commission @ 25% (or $59.70 @ 30%) — 22× larger than Pro monthly's $2.25. Partners self-select to pitch Max annual. Max monthly mirrors Monica.im's Max ($24.90/mo) — comparable AI-companion category benchmark for premium-but-accessible positioning.

### 2.3 Free tier mechanics

Two parallel paths under "Free":

**Path A — Server-mediated 30 min/mo**:
- No Kyma key required.
- User signs in via magic link, gets 30 minutes/month of Standard mode dub through Echoly's master Kyma key.
- After 30 min: hard-block, prompt to upgrade.
- Resets calendar-monthly (1st of each month UTC).

**Path B — BYOK forever**:
- User pastes own Kyma key.
- Unlimited use of any tier (subject to Kyma's own balance).
- No Echoly account required.
- Preserves original v0.5.x privacy commitment.

Path A and Path B can coexist for the same user. If both BYOK key AND active subscription are set, BYOK takes precedence (user owns the cost path).

---

## 3. FUP (Fair Use Policy) enforcement — hard-block

### 3.1 Counting model

- Unit: **billable minutes**, calculated per pipeline call.
- Standard subtitle-first session: bills wall-clock minutes of video played (rounded up to nearest minute per session).
- Standard live fallback (Vertex audio): bills 5-second chunks → rounded up to minute totals.
- Realtime session: bills Kyma session duration (already metered server-side).
- Increment recorded into `usage_events` table after each session ends or each chunk completes.

### 3.2 Cap thresholds (per tier)

| Tier | Standard cap | Realtime cap |
|---|---|---|
| Free (server) | 30 min/mo total | 0 (BYOK only) |
| Pro | 10 hours/mo (600 min) | 0 (BYOK only) |
| Max | 50 hours/mo (3000 min) | 2 hours/mo (120 min) |

#### Cap design — locked 2026-05-19

Two goals: hold a 70% gross margin floor AND keep a clear **5× Pro→Max standard ratio** that forces the upsell. Reference: Otter.ai uses the same ratio (Pro 20h → Business 100h). Echoly's prior 2× ratio was too generous — heavy Pro users had no math reason to upgrade.

**Margin math** (worst case = annual billing). Standard pipeline `gemini-3-flash-audio` at `$0.000648/min`; realtime `gpt-realtime-translate` at `$0.046/min` (~70× standard). Stripe fees: 2.9% + $0.30 + ~$0.05/mo Stripe Tax.

| Tier | Annual price | Net rev/mo | Cost ceiling (30%) | Cap | Cost if maxed | Margin if maxed |
|---|---|---|---|---|---|---|
| Free | $0 | $0 | $0 | 30 min std | $0.019 | absorbed (CAC) |
| Pro | $89/yr | $7.13 | $2.14 | 10 h std | $0.389 | **95% ✓** |
| Max std | $199/yr | $16.01 | $4.80 | 50 h std | $1.944 | **88% ✓** |
| Max realtime | (shared $16.01) | (shared $4.80) | 2 h realtime | $5.52 (+ std $1.94 = $7.46 worst) | **53% worst / ~76% avg** |

**Per-hour value comparison** drives the upsell signal:

| Tier | Std cap | $/h std (monthly billing) |
|---|---|---|
| Pro $9 | 10 h | $0.90/h |
| Max $24.90 | 50 h | $0.50/h |

Max is **44% cheaper per hour** of standard translation than Pro. Math signal: anyone watching >10h/mo upgrades to save money. Realtime stays an exclusive Max bonus, not the upsell trigger.

**If beta data later shows churn at Pro 10h cap** (>20% of paying Pro users hit cap monthly), ranked fallback: (a) raise to 15h (3.3× ratio, Notta pattern), (b) raise Pro monthly to $11–12, (c) keep cap and route harder to Max via in-extension upsell banner.

Free tier 30 min stays — Kyma free monthly window covers most of the cost; treat as customer-acquisition spend.

### 3.3 Hard-block UX flow

```
Usage events arrive → server aggregates current month total per tier
   │
   ├─ < 90% cap   → no signal, normal operation
   │
   ├─ 90% cap     → email warning + extension overlay banner
   │                "You've used 90% of this month's quota"
   │                Banner has "View usage" link to dashboard
   │
   ├─ 100% cap    → next dub session start request:
   │                Server returns 402 Payment Required with body:
   │                { error: "quota_exhausted", tier: "pro",
   │                  resets_at: "2026-06-01T00:00:00Z",
   │                  upgrade_url: "https://echolyhq.com/upgrade" }
   │                Extension shows modal:
   │                "Bạn đã dùng hết quota tháng này.
   │                 Nâng cấp Max, hoặc dùng Kyma key riêng, hoặc đợi tới ngày 1."
   │                Buttons: [Upgrade to Max] [Use Kyma key] [Cancel]
   │
   └─ Active session at moment of cap-hit:
      Session continues until natural end (don't kill mid-video).
      The cap-overage is absorbed by Echoly (small loss, good UX).
```

### 3.4 Reset cycle

- Calendar month, UTC midnight on 1st of each month.
- Cron job at 00:00 UTC daily checks for new month transition and resets counters.
- User sees countdown "X hours, resets in Y days" in dashboard.

### 3.5 Overage policy

v1: **no overage allowed**. Hard block. User must upgrade or wait.
v2 (roadmap, not in this sprint): pay-per-min top-up from balance ($0.06/min Standard, $0.10/min Realtime), purchased in $5/$10/$20 chunks.

---

## 4. User journeys

### 4.1 New user — install then sign up

```
1. Discovers Echoly (CAL post, affiliate link, organic).
2. Clicks Chrome Web Store install button.
3. Opens YouTube video, clicks Echoly icon.
4. Popup shows two options:
   ┌──────────────────────────────────┐
   │ Sign in (free 30 min/mo or paid) │  ← primary CTA
   │ Use my Kyma key (advanced)       │  ← secondary, smaller
   └──────────────────────────────────┘
5. Clicks "Sign in" → opens echolyhq.com/signin in new tab.
6. Enters email → magic link sent → clicks link → authenticated.
7. Browser tab closes, popup state syncs: shows "Free tier — 30 min/mo left".
8. Clicks Start in popup. Video pauses, captions fetched, dub plays.
9. After 30 min consumed (over days), hits cap → upgrade modal.
```

### 4.2 New user — install with affiliate referral

```
1. Partner shares link: echolyhq.com/?ref=PARTNER42
2. User clicks → echolyhq.com landing renders + sets cookie ec_ref=PARTNER42 (30 day)
3. Landing has "Install extension" CTA → Chrome Web Store
4. After install, user opens any youtube.com tab.
5. Content script checks: does cookie ec_ref exist on echolyhq.com origin?
   Reads via fetch('https://echolyhq.com/api/ref-cookie') → server returns code
   Stores in chrome.storage.local.affiliate_ref
6. User signs in / subscribes → Stripe Checkout session includes
   metadata.ref = chrome.storage.local.affiliate_ref
7. Polar webhook fires → Echoly server logs subscription with ref → posts
   commission event to Affitor API.
```

### 4.3 Upgrade Free → Pro

```
1. User hits 100% Free cap (30 min consumed).
2. Modal: "Upgrade to Pro for unlimited dubbing — $9/mo or $89/year (saves 18%)"
3. Click "Upgrade Pro" → opens echolyhq.com/upgrade in new tab.
4. Page lists Pro tier with [Monthly $9] and [Annual $89] buttons.
5. Click → Stripe Checkout session (subscription mode).
6. After payment, Stripe webhook → server updates user.subscription_tier = "pro"
7. Webhook also marks usage cap reset to Pro's 25h limit immediately
   (don't make user wait till next month for upgrade benefit).
8. Email "Welcome to Echoly Pro" sent.
9. User returns to YouTube tab, popup auto-refreshes via background message,
   shows "Pro — 25h/mo".
10. Clicks Start again → unblocked, dub resumes from current video position.
```

### 4.4 Upgrade Pro → Max

```
Same as above except Stripe Checkout uses Max price.
On webhook: existing Pro subscription is updated in place via Stripe API
(stripe.subscriptions.update with new price_id). Pro-rated billing applies.
```

### 4.5 Cancel subscription

```
1. User goes to echolyhq.com/account → "Cancel subscription"
2. Cancellation form: optional reason dropdown + comment box
3. Confirms → server calls stripe.subscriptions.cancel(id, { at_period_end: true })
4. user.subscription_tier remains "pro" but user.cancel_at_period_end = true
5. User retains Pro access until current period ends.
6. Stripe webhook customer.subscription.deleted fires at period end:
   user.subscription_tier = "free"
7. Email "Your subscription ended" sent with re-subscribe link.
8. Cap drops to Free tier 30 min/mo immediately.
```

### 4.6 Payment failure / dunning

```
1. Stripe attempts to renew → card declined.
2. Stripe webhook invoice.payment_failed fires.
3. Echoly does NOT downgrade immediately. Stripe enters "past_due" state.
4. Email user: "Payment failed, update card by [date in 7 days]"
5. Stripe retries 3 times over 7 days per Stripe Smart Retries config.
6. If all retries fail: customer.subscription.deleted webhook → downgrade Free.
7. User can re-subscribe anytime via account page.
```

### 4.7 BYOK user upgrades to subscription

```
1. User has Kyma key set in extension, never signed in.
2. Sees CAL post / hears about Pro tier, decides to subscribe.
3. Clicks "Sign in" in popup → completes magic link → subscribes via Stripe.
4. Popup detects both: BYOK key present AND active subscription.
5. Setting toggle in popup: "Use Echoly subscription [/] OR Use my Kyma key [ ]"
   Default new state: subscription enabled, BYOK fallback if subscription
   hits cap.
```

---

## 5. System architecture

### 5.1 High-level diagram

```
┌──────────────────────┐         ┌────────────────────────────┐
│  Chrome Extension    │         │  echolyhq.com (landing/dash) │
│  • content.js        │         │  • Astro/Next on CF Pages  │
│  • background.js     │         │  • Pricing + Account UI    │
│  • popup.js          │         └────────────────────────────┘
└──────────┬───────────┘                       │
           │                                   │
           │ Bearer <session_token>            │ Session cookie
           ▼                                   ▼
┌────────────────────────────────────────────────────────────┐
│  api.echolyhq.com — Cloudflare Workers                       │
│  • POST /auth/* (Better-Auth magic link)                   │
│  • POST /v1/proxy/* (forward to Kyma after auth + quota)   │
│  • POST /v1/billing/checkout (create Stripe session)       │
│  • POST /v1/billing/portal (Stripe customer portal link)   │
│  • POST /v1/webhooks/stripe (subscription events)          │
│  • GET  /v1/usage (current month usage per user)           │
│  • POST /v1/affiliate/track (capture ref cookie)           │
└─────────┬────────────┬────────────┬────────────────────────┘
          │            │            │
          ▼            ▼            ▼
    ┌─────────┐  ┌──────────┐  ┌─────────────────┐
    │ D1 (DB) │  │  Stripe  │  │ api.kymaapi.com │
    │ users   │  │ Affitor  │  │ (master key,    │
    │ subs    │  │ LLC acc  │  │  not exposed)   │
    │ usage   │  └────┬─────┘  └─────────────────┘
    │ partners│       │
    └─────────┘       ▼
                 ┌────────────────┐
                 │ Affitor API    │
                 │ /commissions   │
                 │ (record events)│
                 └────────────────┘
```

### 5.2 Component responsibilities

**Chrome Extension** (`~/echoly/`):
- Renders popup with Sign In / BYOK choice.
- Stores session_token + affiliate_ref in chrome.storage.local.
- Makes Kyma API calls via `api.echolyhq.com/v1/proxy/*` (server proxy mode) OR direct `api.kymaapi.com/v1/*` (BYOK mode).
- Renders on-page overlay during dub session.

**echolyhq.com landing/dashboard** (new repo `~/echoly-web/`):
- Public landing page with pricing table.
- Signed-in account page with usage chart, invoices, subscription controls.
- Affiliate landing pages with ref cookie capture.

**api.echolyhq.com server** (new repo `~/echoly-server/`):
- Auth (Better-Auth library, magic link via Resend email).
- User + subscription state owner.
- Proxy gateway between extension and Kyma (holds master key).
- Stripe webhook receiver.
- Affitor commission event emitter.
- Usage aggregation + FUP enforcement.

**D1 database**:
- All persistent state (users, subs, usage, partners, commissions cache).

**Stripe (Affitor LLC account)**:
- Subscription billing.
- Customer Portal for self-serve.
- Webhooks for state changes.

**Kyma**:
- AI model gateway (existing infra, Echoly is one customer).
- Master API key held by echoly-server, never exposed to client.

**Affitor API**:
- Commission event receiver.
- Partner payout management.
- Tracking link generator.

---

## 6. Database schema (D1 / SQLite)

### 6.1 Tables

```sql
-- Users
CREATE TABLE users (
  id TEXT PRIMARY KEY,                    -- ULID
  email TEXT UNIQUE NOT NULL,
  email_verified_at INTEGER,              -- unix ms
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  affiliate_ref TEXT,                     -- partner code captured at signup, null if organic
  preferred_language TEXT DEFAULT 'vi',
  preferred_voice TEXT DEFAULT 'English_magnetic_voiced_man'
);

-- Auth sessions (Better-Auth managed)
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,             -- bearer token for extension
  expires_at INTEGER NOT NULL,
  user_agent TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Magic link tokens (Better-Auth managed)
CREATE TABLE magic_links (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,                    -- null until used
  created_at INTEGER NOT NULL
);

-- Subscriptions (one active per user)
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,                    -- ULID, our internal id
  user_id TEXT NOT NULL REFERENCES users(id),
  stripe_customer_id TEXT NOT NULL,
  stripe_subscription_id TEXT UNIQUE NOT NULL,
  stripe_price_id TEXT NOT NULL,          -- which price (pro_monthly, max_annual, etc.)
  tier TEXT NOT NULL CHECK(tier IN ('free', 'pro', 'max')),
  billing_cycle TEXT NOT NULL CHECK(billing_cycle IN ('monthly', 'annual', 'free')),
  status TEXT NOT NULL,                   -- active|past_due|canceled|incomplete
  current_period_start INTEGER NOT NULL,
  current_period_end INTEGER NOT NULL,
  cancel_at_period_end INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_subs_user ON subscriptions(user_id);
CREATE INDEX idx_subs_stripe ON subscriptions(stripe_subscription_id);
CREATE INDEX idx_subs_status_period ON subscriptions(status, current_period_end);

-- Usage events (one per billable unit consumed)
CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,                    -- ULID
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT,                        -- extension-side session id (UUID)
  mode TEXT NOT NULL CHECK(mode IN ('standard', 'realtime')),
  source TEXT NOT NULL,                   -- 'subtitle-first' | 'live-fallback' | 'realtime'
  billable_minutes INTEGER NOT NULL,      -- rounded up
  cost_usd REAL NOT NULL,                 -- Echoly's Kyma cost for this event
  model_used TEXT,                        -- e.g. 'gemini-3-flash-audio'
  created_at INTEGER NOT NULL,
  -- aggregation helpers
  year_month TEXT NOT NULL                -- 'YYYY-MM' for fast monthly group-by
);

CREATE INDEX idx_usage_user_month ON usage_events(user_id, year_month);
CREATE INDEX idx_usage_created ON usage_events(created_at);

-- Monthly usage aggregate (denormalized cache for fast FUP checks)
CREATE TABLE usage_summary (
  user_id TEXT NOT NULL,
  year_month TEXT NOT NULL,
  standard_minutes INTEGER NOT NULL DEFAULT 0,
  realtime_minutes INTEGER NOT NULL DEFAULT 0,
  total_cost_usd REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, year_month)
);

-- Partners (affiliate)
CREATE TABLE partners (
  code TEXT PRIMARY KEY,                  -- e.g. 'NGUYENTUNG'
  affitor_partner_id TEXT,                -- Affitor's own id (cross-reference)
  display_name TEXT NOT NULL,
  email TEXT NOT NULL,
  commission_tier TEXT NOT NULL CHECK(commission_tier IN ('default', 'top')),
  first_payment_pct INTEGER NOT NULL,     -- 25 or 30
  recurring_pct INTEGER NOT NULL,         -- 10 or 12
  created_at INTEGER NOT NULL,
  active INTEGER DEFAULT 1
);

-- Commission events (audit trail; canonical record lives in Affitor)
CREATE TABLE commission_events (
  id TEXT PRIMARY KEY,
  partner_code TEXT NOT NULL REFERENCES partners(code),
  user_id TEXT NOT NULL REFERENCES users(id),
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  type TEXT NOT NULL CHECK(type IN ('first_payment', 'renewal')),
  gross_amount_usd REAL NOT NULL,         -- subscription payment
  commission_amount_usd REAL NOT NULL,    -- 25/30% or 10/12%
  posted_to_affitor_at INTEGER,           -- null until POST succeeds
  affitor_event_id TEXT,                  -- Affitor's returned id
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_commissions_partner ON commission_events(partner_code);
CREATE INDEX idx_commissions_pending ON commission_events(posted_to_affitor_at) WHERE posted_to_affitor_at IS NULL;

-- Email send log (for debugging + dedupe)
CREATE TABLE email_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  template TEXT NOT NULL,                 -- 'welcome' | 'usage_80' | 'usage_100' | etc.
  sent_at INTEGER NOT NULL,
  message_id TEXT                         -- Resend message id
);

CREATE INDEX idx_email_user_template ON email_log(user_id, template);
```

### 6.2 Migration management

- Use Wrangler's D1 migrations: `wrangler d1 migrations create echoly add_users_table`.
- All migrations live in `~/echoly-server/migrations/`.
- Each migration is a single SQL file, numbered: `0001_initial.sql`, `0002_add_voices.sql`, etc.
- CI runs `wrangler d1 migrations apply echoly --remote` on deploy.

---

## 7. Auth flow (Better-Auth + magic link)

### 7.1 Why Better-Auth not Clerk

- Self-hosted, no per-MAU fee (Clerk pricing scales to $200+/mo at 1K users).
- Native CF Workers + D1 adapter exists.
- Magic link is built-in, no Twilio/Auth0 needed for SMS variants v1.
- Open source, future-portable.

### 7.2 Magic link flow

```
1. User enters email on echolyhq.com/signin
   POST /api/auth/sign-in/magic-link { email: "son@example.com" }

2. Server (Better-Auth):
   - Generate token (32 char random)
   - Insert into magic_links table, expires_at = now + 15 min
   - Send email via Resend with link:
     https://api.echolyhq.com/auth/callback?token=ABC123

3. User clicks link in email
   GET /api/auth/callback?token=ABC123
   - Validate token, mark consumed_at = now
   - Find or create user record (insert if email not in users)
   - Issue session: insert into sessions with token, expires_at = now + 30 days
   - Set cookie: ec_session=<session_token>; HttpOnly; Secure; SameSite=Lax
   - 302 redirect to https://echolyhq.com/account

4. Extension fetches session token:
   - Popup loads → if no session_token in chrome.storage, redirect to signin
   - After signin, content script on echolyhq.com origin reads session cookie
     via window.cookie (since extension content script shares cookie jar)
   - Sends to background: SET_SESSION_TOKEN
   - background.js stores in chrome.storage.local.session_token
   - All subsequent requests to api.echolyhq.com use Authorization: Bearer <token>
```

### 7.3 Session management

- 30-day rolling sessions (refresh on each authenticated request).
- Logout: delete session row + clear cookie + clear chrome.storage.
- Concurrent sessions: allowed (user can have multiple devices). Cap 5 sessions per user (oldest dropped).
- Session token rotation: on each authenticated request, if session is > 7 days old, issue new token and update chrome.storage.

### 7.4 Email provider: Resend

- $20/mo for 50K emails (sufficient for first 6 months at projected user count).
- Domain authentication: `api.echolyhq.com` SPF + DKIM + DMARC records.
- Templates managed in code (`~/echoly-server/src/emails/`), rendered with React Email.

---

## 8. Stripe integration

### 8.1 Products + prices (created in Stripe dashboard, Affitor LLC account)

| Product | Price IDs | Amount | Interval |
|---|---|---|---|
| Echoly Pro | `price_echoly_pro_monthly` | $9.00 | month |
| Echoly Pro | `price_echoly_pro_annual` | $89.00 | year |
| Echoly Max | `price_echoly_max_monthly` | $19.00 | month |
| Echoly Max | `price_echoly_max_annual` | $159.00 | year |

All prices in USD. Tax handled via Stripe Tax (auto-collect by user country).

### 8.2 Stripe account architecture

**Dedicated Stripe account for Echoly, under Affitor LLC EIN, mirroring the Kyma-api pattern.** Separate from Affitor's own merchant account and from any other product line.

Decision rationale (locked 2026-05-17):
- **Clean revenue reporting**: Echoly's MRR, ARR, churn, LTV are visible in their own dashboard with no need to filter Affitor's subscriptions out.
- **Independent payouts**: Echoly's bank transfers land as distinct line items, making intercompany accounting trivial (Echoly = product line, money flows to Affitor LLC's single bank).
- **Affitor self-affiliate clean**: when Affitor (as the affiliate platform) tracks Echoly's commission events, Echoly looks like just another merchant client — same treatment as future 3rd-party Affitor merchants. No special-case logic.
- **Future-proof**: if Echoly ever sells / spins out / IPOs, the books are already separated. Migration is a bank account swap, not a customer migration project.
- **Same EIN advantage retained**: tax filing remains single 1099/W-9 per year (Affitor LLC). Stripe permits multiple accounts under one EIN by design.

Trade-off accepted: lose volume-aggregation eligibility for Stripe Volume tier discount until Echoly hits $80K+/yr on its own. At Y1 projected $53K, the tier discount wouldn't have applied to a shared account anyway, so cost is zero.

### 8.3 Metadata convention

Even with a dedicated Echoly Stripe account, every object carries `metadata.product = "echoly"` for forward-compatibility (any future internal tooling can rely on this tag).

- Customer metadata: `metadata.product = "echoly"`, `metadata.echoly_user_id = <our_user_id>`
- Subscription metadata: `metadata.product`, `metadata.echoly_user_id`, `metadata.echoly_tier`, `metadata.affiliate_ref`
- Checkout session metadata: same as subscription

### 8.4 Card statement descriptor

Stripe's default statement descriptor for an Affitor-LLC-EIN account is the legal name ("AFFITOR LLC"), which is opaque to Echoly customers. Override at subscription creation time so the descriptor matches the product brand:

```typescript
await stripe.subscriptions.create({
  customer: customerId,
  items: [{ price: priceId }],
  metadata: { product: "echoly", echoly_user_id: userId, affiliate_ref: ref ?? "" },
  statement_descriptor_suffix: "ECHOLY SUB",  // shown on card statement
});
```

Stripe enforces ALL CAPS, 5-22 chars, alphanumeric + space only. Card statement appears as `AFFITOR* ECHOLY SUB` so the user immediately recognizes the charge.

Also configure the **account-level** "Doing business as" name to "Echoly" in the dedicated Stripe dashboard (Settings → Account details), so receipts and Stripe Customer Portal show "Echoly" branding instead of "Affitor LLC" everywhere customer-facing.

### 8.5 Checkout session creation

```typescript
// POST /v1/billing/checkout
async function createCheckout(userId: string, priceId: string, ref?: string) {
  const user = await getUser(userId);
  let customerId = user.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: { product: "echoly", echoly_user_id: userId },
    });
    customerId = customer.id;
    await db.update(users).set({ stripe_customer_id: customerId }).where(eq(users.id, userId));
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: "https://echolyhq.com/account?welcome=1",
    cancel_url: "https://echolyhq.com/pricing?canceled=1",
    metadata: {
      product: "echoly",
      echoly_user_id: userId,
      affiliate_ref: ref ?? "",
    },
    subscription_data: {
      metadata: {
        product: "echoly",
        echoly_user_id: userId,
        affiliate_ref: ref ?? "",
      },
    },
    allow_promotion_codes: true,
    automatic_tax: { enabled: true },
  });

  return { url: session.url };
}
```

### 8.6 Webhook events (full handler list)

POST `/v1/webhooks/stripe` — verifies signature with `STRIPE_WEBHOOK_SECRET`.

| Event | Action |
|---|---|
| `checkout.session.completed` | Activate subscription. Create commission event if affiliate_ref present. |
| `customer.subscription.created` | Insert subscriptions row. Update user.subscription_tier. |
| `customer.subscription.updated` | Update subscriptions row (handles upgrades, downgrades, renewals). |
| `customer.subscription.deleted` | Downgrade user to free tier. Send "subscription ended" email. |
| `invoice.payment_succeeded` | If invoice.billing_reason === "subscription_cycle" → create renewal commission event. |
| `invoice.payment_failed` | Send dunning email. Mark subscription.status = past_due. |
| `customer.subscription.trial_will_end` | Not used in v1 (no trials). |

### 8.7 Webhook idempotency

Stripe may deliver the same event multiple times. Echoly de-dupes:
- Each webhook handler checks `event.id` against `webhook_events` table.
- If already processed, return 200 without re-running side effects.
- Insert event.id atomically after side effects complete.

```sql
CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,             -- stripe event.id
  type TEXT NOT NULL,
  processed_at INTEGER NOT NULL
);
```

### 8.8 Customer Portal

- Stripe Customer Portal handles: cancel, update card, switch plan, download invoices.
- `POST /v1/billing/portal` returns a portal URL for the authenticated user.
- Configured in Stripe dashboard: allow plan switching between Pro/Max (both directions), allow cancel at period end (not immediate), enable invoice history.

---

## 9. Server proxy to Kyma

### 9.1 Endpoint design

The extension hits Echoly's server instead of Kyma directly. Echoly forwards to Kyma using its master key, after authorizing the user.

```
POST /v1/proxy/chat/completions     → forwards to api.kymaapi.com/v1/chat/completions
POST /v1/proxy/audio/transcriptions → forwards to api.kymaapi.com/v1/audio/transcriptions
POST /v1/proxy/audio/understand     → forwards to api.kymaapi.com/v1/audio/understand
POST /v1/proxy/audio/speech         → forwards to api.kymaapi.com/v1/audio/speech
POST /v1/proxy/realtime/translations/client_secrets → forwards
POST /v1/proxy/realtime/translations/sessions/:id/heartbeat → forwards
POST /v1/proxy/realtime/translations/sessions/:id/end → forwards
POST /v1/proxy/live/sessions        → forwards (Gemini Live, future)
```

### 9.2 Request flow

```
Extension                Echoly Server               Kyma
   │                          │                       │
   │  Auth: Bearer <ec_token> │                       │
   │  POST /v1/proxy/audio/speech                     │
   │  body: { input, voice_id, ... }                  │
   ├─────────────────────────►│                       │
   │                          │                       │
   │                       1. Look up user by token   │
   │                       2. Check subscription tier │
   │                       3. Check usage cap         │
   │                          │                       │
   │                          ├─ 402 if cap exhausted │
   │                          ├─ 401 if no session    │
   │                          ├─ 403 if Realtime requested by Pro user (Max-only)
   │                          │                       │
   │                       4. Forward to Kyma with master key:
   │                          │  Bearer <KYMA_MASTER_KEY>
   │                          │  POST /v1/audio/speech
   │                          ├──────────────────────►│
   │                          │                       │ ...process
   │                          │◄──────────────────────┤ 200 + audio bytes
   │                          │                       │
   │                       5. Calculate billable minutes from response/duration
   │                       6. Insert usage_event
   │                       7. Update usage_summary
   │                          │                       │
   │◄─────────────────────────┤                       │
   │  200 + audio bytes       │                       │
   │  X-Echoly-Usage: { minutes_remaining: 1450, cap: 1500 }
```

### 9.3 Master key handling

- `KYMA_MASTER_KEY` stored in Cloudflare Workers secret (encrypted at rest, only decrypted in worker memory).
- Never logged. Never returned to client.
- Rotation: every 90 days. Procedure documented in `~/echoly-server/SECURITY.md`.

### 9.4 BYOK pass-through mode

When user prefers BYOK (subscription disabled OR user opted out), extension still sends requests to Kyma directly using user's own key. Echoly server is bypassed entirely.

This is enforced client-side: if `chrome.storage.local.use_subscription === false`, set KYMA_BASE = `https://api.kymaapi.com/v1`. Otherwise use `https://api.echolyhq.com/v1/proxy`.

### 9.5 Cost tracking

Each proxy call records actual cost using the same calculation logic as Kyma (`AUDIO_COSTS` + `AUDIO_SPEECH_COSTS` tables from kyma-api). Costs stored to `usage_events.cost_usd` and aggregated into `usage_summary.total_cost_usd` for Son's analytics.

Why track cost separately from minutes:
- Minutes drive FUP (user-facing).
- Cost drives margin analysis (Son-facing).
- They diverge: e.g. user with mostly subtitle-first usage has lower cost-per-minute than mostly live-fallback.

---

## 10. Extension changes (~/echoly/)

### 10.1 New files

```
~/echoly/
├── manifest.json                   ← bump permissions
├── content.js                      ← add KYMA_BASE swap + session header
├── background.js                   ← add SET_SESSION_TOKEN handler
├── popup.html                      ← add Sign In / Account section
├── popup.js                        ← add auth state UI
├── popup.css                       ← styles for new auth UI
└── pages/
    ├── auth-redirect.html           ← receives session token from echolyhq.com
    └── auth-redirect.js
```

### 10.2 manifest.json deltas

Add hosts for echolyhq.com and api.echolyhq.com:

```json
"host_permissions": [
  "https://*.youtube.com/*",
  "https://youtube.com/*",
  "https://api.kymaapi.com/*",
  "https://api.openai.com/*",
  "https://api.echolyhq.com/*",
  "https://echolyhq.com/*"
]
```

Add content script for echolyhq.com origin (to read session cookie):

```json
"content_scripts": [
  { /* existing youtube.com block */ },
  {
    "matches": ["https://echolyhq.com/auth/callback*"],
    "js": ["pages/auth-redirect.js"],
    "run_at": "document_idle"
  }
]
```

Bump version to 1.0.0 (subscription = major release).

### 10.3 popup.html new section

```html
<section class="auth-block" id="authBlock">
  <!-- shown when no session -->
  <div data-auth-state="signed-out">
    <button id="signInBtn" class="action-secondary">Sign in for unlimited dub</button>
    <p class="hint">Or paste your Kyma key below for BYOK mode.</p>
  </div>

  <!-- shown when signed in -->
  <div data-auth-state="signed-in" hidden>
    <div class="account-row">
      <span class="account-email" data-account-email></span>
      <span class="tier-badge" data-tier-badge>Pro</span>
    </div>
    <div class="usage-bar">
      <div class="usage-fill" data-usage-fill style="width:30%"></div>
      <span class="usage-label" data-usage-label>7.5h / 25h this month</span>
    </div>
    <a href="https://echolyhq.com/account" target="_blank" class="link">Account</a>
    <button id="signOutBtn" class="link">Sign out</button>
  </div>
</section>
```

### 10.4 popup.js state additions

```typescript
type AuthState = {
  signedIn: boolean;
  email?: string;
  tier?: 'free' | 'pro' | 'max';
  usageMinutes?: number;
  capMinutes?: number;
  realtimeMinutesUsed?: number;
  realtimeCap?: number;
  byokKey?: string;  // separate from subscription
  useSubscription: boolean;  // user preference toggle
};
```

On popup open: send `GET_AUTH_STATE` to background. Background returns merged state from chrome.storage + cached usage (refreshed every 60s when popup is open, or on demand via `/v1/usage` call).

### 10.5 Auth redirect flow

```
1. User clicks "Sign in" in popup
2. Popup opens https://echolyhq.com/signin in new tab
3. User completes magic link
4. Magic link callback redirects to https://echolyhq.com/auth/callback?token=...
5. pages/auth-redirect.js content script fires:
   - Reads session cookie via document.cookie
   - Sends to background: { type: 'SET_SESSION_TOKEN', token, email, tier }
   - Closes the tab (window.close() works because tab was opened by extension)
6. Background.js stores token in chrome.storage.local
7. Broadcasts to popup if open: BACKGROUND_STATE_UPDATE
8. Popup re-renders signed-in UI
```

### 10.6 KYMA_BASE dynamic swap

In content.js:

```javascript
function getKymaBase() {
  // Subscription mode → proxy. BYOK mode → direct.
  if (settings.useSubscription && settings.sessionToken) {
    return "https://api.echolyhq.com/v1/proxy";
  }
  return "https://api.kymaapi.com/v1";
}
```

All existing fetch calls update from constant `KYMA_BASE` to function call. The auth header similarly switches between `Bearer ${sessionToken}` (server proxy) and `Bearer ${kymaKey}` (BYOK).

### 10.7 Cap-hit UI in content.js

When server returns 402 with `error: "quota_exhausted"`:

```javascript
if (resp.status === 402) {
  const body = await resp.json();
  if (body.error === "quota_exhausted") {
    stopSession("quota-exhausted");
    showQuotaModal({
      tier: body.tier,
      resetsAt: body.resets_at,
      upgradeUrl: body.upgrade_url,
    });
    return;
  }
}
```

The modal is a new overlay rendered inside the on-page panel (or as separate modal if panel is hidden), with three buttons: Upgrade / Use Kyma key / Cancel.

---

## 11. Web dashboard (~/echoly-web/)

### 11.1 Tech stack

- Astro (static-first, ships minimal JS) on Cloudflare Pages.
- Tailwind CSS.
- React islands only for interactive components (account page, signin form).
- Total cold-start bundle target: < 50 KB JS.

### 11.2 Pages

```
echolyhq.com/                  ← landing (pricing, hero, features)
echolyhq.com/pricing           ← pricing page (alias for /)
echolyhq.com/signin            ← magic link request form
echolyhq.com/auth/callback     ← consumed by extension, also redirects to /account
echolyhq.com/account           ← authenticated dashboard
echolyhq.com/affiliate         ← public partner program info + apply button
echolyhq.com/privacy           ← privacy policy (updated for subscription data)
echolyhq.com/terms             ← terms of service
echolyhq.com/about             ← about page
```

### 11.3 Landing page (/)

Hero section:
- Headline: "Watch any YouTube video in your language."
- Sub: "Live AI dub with native voices. Zero setup required."
- CTA: [Install Extension] [See Pricing]
- Below fold: 3 use case cards (Learn / Watch tech / Live streams)

Pricing table (3 columns side-by-side, Pro highlighted as "Most popular"):
- Free / Pro / Max columns
- Feature comparison rows
- [Subscribe Pro Monthly] / [Subscribe Pro Annual SAVE 18%] buttons
- [Subscribe Max Monthly] / [Subscribe Max Annual SAVE 30%] buttons

Footer: links to terms, privacy, affiliate program, support email.

### 11.4 Account page (/account)

Sections:
1. **Subscription status card**
   - Current tier badge
   - Next billing date
   - "Manage subscription" button → Stripe Customer Portal
   - "Cancel subscription" button → confirmation flow

2. **Usage card**
   - Standard: progress bar + "X h / Y h this month, resets in Z days"
   - Realtime (Max only): similar bar
   - Mini chart: daily usage last 30 days

3. **Affiliate referral card** (if user is a partner)
   - Their referral code + copy button
   - Lifetime revenue referred + commission earned
   - Link to full Affitor partner dashboard

4. **Settings card**
   - Default target language
   - Default voice
   - Email notification preferences (usage warnings on/off)

5. **Invoices card**
   - Last 6 invoices from Stripe with download links

6. **Danger zone**
   - Logout
   - Delete account (60-day grace period, full data export option)

### 11.5 Affiliate page (/affiliate)

Public marketing page for the partner program:
- Hero: "Earn 25-30% commission promoting Echoly"
- How it works: 3 steps (Sign up → Get link → Earn)
- Commission tiers explained
- Top performer criteria
- Apply form → sends to Son for manual approval (first 10 partners), automated later

---

## 12. Affiliate integration (Affitor)

### 12.1 Partner lifecycle

```
1. Partner applies via echolyhq.com/affiliate/apply
2. Son reviews application manually (first 10 partners), approves
3. Echoly server creates partner record:
   - Generates 8-char code (e.g., NGTUNG42)
   - commission_tier = 'default' (25% / 10%)
4. Server registers with Affitor API:
   POST https://api.affitor.com/v1/merchants/echoly/partners
   { display_name, email, commission_tier, code }
   Returns: affitor_partner_id
5. Echoly stores affitor_partner_id in partners table
6. Welcome email sent to partner with:
   - Their tracking link: https://echolyhq.com/?ref=NGTUNG42
   - Login to Affitor partner dashboard
   - Commission terms PDF
```

### 12.2 Click → install → subscribe attribution flow

```
1. User clicks https://echolyhq.com/?ref=NGTUNG42
2. Landing page loads, server sets cookie:
   Set-Cookie: ec_ref=NGTUNG42; Max-Age=2592000; Path=/; SameSite=Lax
3. (Optional logging) Server POST to Affitor:
   POST /v1/clicks { partner_code: "NGTUNG42", landing_url: "/" }
4. User clicks "Install extension" → Chrome Web Store install page
5. After install, user visits any youtube.com tab
6. Background script triggers one-time check:
   - On extension startup (chrome.runtime.onInstalled), opens hidden iframe to
     https://echolyhq.com/api/ref-check (server reads ec_ref cookie, returns JSON)
   - Stores result in chrome.storage.local.affiliate_ref
   - Cookie + storage both expire 30 days from click
7. When user later signs up + subscribes:
   - Server reads affiliate_ref from request context
   - Passes it as metadata.ref in Stripe Checkout session
   - Stripe webhook receives it back in subscription.metadata
   - Echoly server creates commission_event row
   - Posts to Affitor: POST /v1/commissions
     { partner_code, user_id, amount_usd, type: "first_payment" }
```

### 12.3 Commission calculation — Affitor owns

**Locked 2026-05-19**: commission rate config and amount calculation live on Affitor, not Echoly. Echoly is a thin payment-event forwarder.

- Partner config (default vs top tier, first_payment_pct, recurring_pct, payout rules) → Affitor DB.
- Commission amount math → Affitor's `/commissions` endpoint computes from `gross_amount_usd` + Affitor-side partner rate lookup.
- Top-performer promotion → Affitor automates internally (no Echoly involvement).
- Echoly does NOT maintain a local `partners` table, does NOT mirror commission rates, does NOT calculate commission_amount. Source of truth is Affitor.

Rationale: prevent rate-drift between two systems when Affitor flips a partner's tier (e.g. monthly auto-promote). Affitor is the affiliate system of record — Echoly is just one of its merchant clients (treated identically to future 3rd-party Affitor merchants).

### 12.4 Top performer promotion — Affitor automates

Quarterly threshold ($5K cumulative or 50 active subs) is enforced on Affitor's side using its own DB + cron. Echoly receives no signal here; the next commission POST will be credited at whatever rate Affitor applies. Partners see promotion confirmation in their Affitor dashboard / email, not on Echoly.

### 12.5 Affitor API contract (Echoly → Affitor)

Echoly is one of Affitor's merchant clients. The only outbound contract Echoly depends on:

```
POST /v1/merchants/echoly/commissions
  Body: {
    partner_code,        // Stripe metadata.affiliate_ref pass-through
    user_id,             // Echoly's ULID — opaque to Affitor, used for dedupe
    subscription_id,     // Echoly's internal subscription ULID
    type,                // 'first_payment' | 'renewal'
    gross_amount_usd,    // Stripe amount_total / amount_paid / 100
    source_event_id      // Stripe event.id — Affitor's idempotency key
  }
  Returns: { commission_id, status }   // Affitor decides commission amount; Echoly stores only commission_id
```

Echoly's local `commission_events` table is a forward-audit log (which Stripe events did we POST, did Affitor 2xx ack), not a commission ledger. Schema fields:

```
id, user_id, subscription_id, partner_code, type, gross_amount_usd,
source_event_id, posted_to_affitor_at, affitor_event_id, created_at
```

No `commission_amount_usd`, no `first_payment_pct/recurring_pct`. If Affitor API isn't ready, rows stay with `posted_to_affitor_at = NULL` and a Day-5 cron retries pending. CSV export is the manual fallback.

---

## 13. Email notifications

### 13.1 Template list

| Trigger | Template | Frequency cap |
|---|---|---|
| Magic link request | `auth_magic_link` | None (request-driven) |
| Signup (first time) | `welcome_free` | Once per user |
| Subscription created | `welcome_paid` | Once per subscription |
| Payment succeeded (renewal) | `renewal_receipt` | Per renewal |
| Payment failed | `payment_failed` | Max 3 per failed cycle |
| Usage 90% | `usage_warning_90` | Once per month per tier |
| Usage 100% | `usage_warning_100` | Once per month per tier |
| Subscription cancelled (scheduled) | `subscription_canceling` | Once |
| Subscription ended | `subscription_ended` | Once per end |
| Partner approval | `partner_welcome` | Once |
| Partner commission earned | `commission_earned` | Weekly digest |

### 13.2 Template guidelines

- Subject lines ≤ 60 chars.
- Vietnamese + English bilingual (Vi on top, En below, separated by horizontal rule).
- Plain text fallback for every HTML version.
- Always include unsubscribe link for non-transactional emails (usage warnings only — receipts are transactional, no unsub).
- Footer: company address (Affitor LLC's), support email, privacy link.

### 13.3 Resend setup

- Domain: `mail.echolyhq.com` (subdomain to keep DKIM separate from app traffic).
- DKIM, SPF, DMARC records set in Cloudflare DNS.
- Sender identity: "Echoly <noreply@mail.echolyhq.com>" for transactional, "Echoly Team <hi@echolyhq.com>" for support replies.

---

## 14. Edge cases catalog

| # | Case | Handling |
|---|---|---|
| 1 | User has both BYOK key AND active subscription | Setting toggle: default subscription, BYOK as fallback. User chooses. |
| 2 | User signs up but never installs extension | Subscription is active server-side. Email week 1: "Don't forget to install the extension". |
| 3 | User installs extension but never signs up | Free tier server-mediated only works after signin. BYOK works without. Popup shows clear "Sign in for free 30 min" or "Use Kyma key" choice. |
| 4 | Subscription expires mid-session | Active dub session continues to end. Next session start blocked. |
| 5 | Stripe webhook delivered twice | Dedupe via webhook_events table. Second delivery returns 200 with no side effect. |
| 6 | Stripe webhook delayed > 1 hour | Acceptable for billing events (subscription status sync). Cap enforcement runs against last-known state. |
| 7 | User refunds within 7 days | Stripe sends customer.subscription.deleted. Echoly downgrades immediately. No prorated refund of usage. |
| 8 | Concurrent sessions limit | Free 1 / Pro 2 / Max 3 sessions across all devices. Enforced server-side: 4th session start returns 429. Same as Realtime limit in Kyma. |
| 9 | User changes language mid-session | Already handled per existing code, no change. |
| 10 | User cancels then re-subscribes same month | Treated as new subscription. Affiliate gets first_payment commission if ref cookie still present. |
| 11 | Partner refers themselves | Detected via email match. Self-referral commissions are zeroed (logged but not paid). |
| 12 | Multiple referrals same user | Last-touch attribution (most recent ref cookie wins). Documented in partner terms. |
| 13 | User in unsupported country (Stripe blocked) | Stripe Checkout shows error. Echoly displays fallback message: "Subscription not available in your country. Use BYOK Kyma key instead." |
| 14 | Free tier user opens > 1 tab | Quota enforced globally per user. Two simultaneous Standard sessions both eat quota. |
| 15 | Hard-block hit during active session | Session continues. Cap-overage absorbed. Next session start blocked. |
| 16 | Quota resets at 00:00 UTC during active session | Session continues using next month's quota. |
| 17 | User deletes account during active subscription | Account deletion scheduled with 60-day grace. Subscription continues until period end. After deletion, Stripe customer kept for tax record. |
| 18 | YouTube changes timedtext signing | Subtitle-first fails → falls back to live mode (Vertex audio). Cost rises but service degrades gracefully. Email Son alert if fallback rate > 50% across users. |
| 19 | Kyma master key compromised | Rotate via Cloudflare secret update + invalidate at Kyma side. Procedure in SECURITY.md. |
| 20 | D1 quota exceeded | D1 has 5GB free + paid scaling. Monitor via dashboard. Migration to PlanetScale documented as escape. |

---

## 15. Security

### 15.1 Threat model

Assets to protect:
- User Kyma keys (BYOK users)
- User email + auth state
- Echoly's master Kyma key (financial impact if leaked)
- Stripe customer data (PII + payment indirect via Stripe)

Adversaries:
- Random web attacker (XSS, CSRF)
- Malicious page on youtube.com (extension context injection)
- Compromised dependency (supply chain)
- Malicious Echoly user (quota bypass, scraping)

### 15.2 Controls

| Asset | Control |
|---|---|
| User Kyma keys | Stored in chrome.storage.local with TRUSTED_CONTEXTS access level. Never sent over network. |
| Session tokens | HttpOnly cookie (web) + chrome.storage.local (extension). Never logged. |
| Master Kyma key | Cloudflare Workers secret. Only decrypted at request time. Never returned in any response. |
| Stripe payment data | Echoly never sees raw card data. Stripe-hosted checkout + customer portal. |
| Auth tokens | 30-day rolling sessions, rotated on each 7-day-old request. Revocable via logout. |
| Webhook validity | Stripe signature verification with STRIPE_WEBHOOK_SECRET. Reject unsigned. |
| Affitor commission POST | HMAC signature on outbound requests using shared secret. Affitor verifies. |
| Magic link tokens | 32-char random, single-use, 15-min TTL. consumed_at marker prevents reuse. |
| Cross-origin XSS | CSP `script-src 'self'` on dashboard. No inline scripts. No third-party CDN. |
| Extension popup XSS | textContent only, no innerHTML for user data. (Existing pattern preserved.) |
| CSRF | SameSite=Lax cookies + CSRF token on state-changing requests from web dashboard. |
| Rate limiting | Per-user 100 req/min on /v1/proxy/*. Higher 200/min for /v1/usage. CF rate limiter. |

### 15.3 Secrets inventory

Cloudflare Workers secrets (set via wrangler):
- `KYMA_MASTER_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `RESEND_API_KEY`
- `AFFITOR_API_KEY`
- `AFFITOR_HMAC_SECRET`
- `BETTER_AUTH_SECRET` (for session token signing)

All other config (URLs, plan IDs) lives in `wrangler.toml` non-secret env vars.

### 15.4 Privacy policy updates

Existing v0.5.x privacy policy stated "no Echoly-operated server". This becomes inaccurate. New policy needs:
- Disclose that subscription users go through api.echolyhq.com
- Document what data is stored (email, usage events, no raw video/audio)
- Stripe sub-processor disclosure
- Kyma sub-processor disclosure
- Resend sub-processor disclosure
- Cloudflare D1 sub-processor disclosure
- Affitor sub-processor disclosure (for affiliate flow)
- Data retention: usage_events 24 months, sessions 30 days, magic_links 15 min
- User right to export (GET /v1/user/export → JSON of all their data)
- User right to delete (60-day grace, then full deletion)

---

## 16. Observability

### 16.1 Logs

- Cloudflare Workers logs go to Logpush → R2 bucket for 30-day retention.
- Logged: request method, path, user_id (hashed), status, latency, cost_usd.
- NOT logged: bearer tokens, request bodies (may contain audio), Stripe webhook bodies.

### 16.2 Metrics

Track in Workers Analytics Engine (free, built-in):
- Request count per endpoint
- Latency p50/p95/p99
- Error rate per endpoint
- Cost per user per month (rolling)
- Stripe webhook lag (received_at - event.created)
- FUP cap-hit rate per tier
- Subscription conversions per source (organic vs affiliate)
- Churn per cohort (monthly)

### 16.3 Alerts

Slack webhook for:
- Stripe webhook fail rate > 5% over 10 min
- Kyma proxy error rate > 10% over 5 min
- Cost-per-user spike > 3× baseline (potential abuse)
- D1 query failures
- Daily cost burn projection > monthly revenue × 1.5 (warning)

### 16.4 Cost dashboard

Internal admin page at echolyhq.com/admin (Son-only, IP-restricted):
- Current MRR
- COGS this month (sum of usage_events.cost_usd)
- Net margin
- Top 10 highest-cost users (potential abusers or genuine power users)
- Affiliate commission outstanding

---

## 17. Legal updates

### 17.1 New documents needed

| Doc | Owner | Location |
|---|---|---|
| Terms of Service | Affitor LLC | echolyhq.com/terms |
| Privacy Policy (rewrite) | Affitor LLC | echolyhq.com/privacy |
| Refund Policy | Affitor LLC | echolyhq.com/refunds |
| Affiliate Partner Agreement | Affitor LLC | echolyhq.com/affiliate/terms |
| DPA template (for B2B users, future) | Affitor LLC | drafted Q3 |

### 17.2 Refund policy (proposed)

- Monthly: full refund within 7 days of subscription start if zero usage. Pro-rated after that.
- Annual: full refund within 14 days, regardless of usage.
- No refunds for accidental overuse (FUP prevents this anyway).
- Refund via Stripe takes 5-10 business days.

### 17.3 Acceptable use policy

Bullet list:
- Personal use only. Don't share account.
- Don't bulk-process content you don't have rights to translate/redistribute.
- Don't abuse for commercial transcription service (use Kyma direct API instead).
- Don't reverse-engineer or scrape (it's open source anyway, but no impersonation).
- Account sharing → suspension.

---

## 18. Launch + roadmap

### 18.1 Soft launch (Day 6, post-sprint)

- Cơm AI Lò post announcing subscription tier (Vietnamese, ~300 words).
- Reference 155.9K member distribution from memory `project_comailo_group`.
- Promo: first 100 annual subscribers get $20 off via code FOUNDER100.
- Recruit 3 trusted CAL admins as initial affiliate partners with 30% tier from day 1.

### 18.2 Hard launch (Week 2-4)

- Affiliate program public on echolyhq.com/affiliate.
- LinkedIn post in English targeting AI/dev audience (mention as Affitor LLC product).
- X/Twitter post with demo video.
- Reach out to 5 VN tech YouTubers for review/affiliate offer.

### 18.3 KPI targets first 90 days

- 1000 free signups
- 50 paid Pro users
- 5 paid Max users
- 5 active affiliate partners with > $100 commission earned
- < 10% monthly churn
- < $0.50 average cost per paid user per month (after FUP)

### 18.4 Post-launch roadmap

| Quarter | Focus | Items |
|---|---|---|
| Q3 2026 | Multi-platform | Add Coursera, Udemy, edX, Khan Academy CC support (Phase 2 from v0.5 backlog) |
| Q3 2026 | Gemini Live tier | Ship Gemini Live as 3rd tier (Task #13 deferred) |
| Q4 2026 | Voice clone | Premium voice cloning for Max users (Azure CNV or ElevenLabs Custom) |
| Q4 2026 | Mobile companion | iOS/Android app for content saved/queued from extension |
| Q1 2027 | Enterprise tier | $500/mo team seats, SAML SSO, usage analytics, custom voice |

---

## 19. Engineering tasks broken down (5-day sprint)

### Day 1 — Foundation (✅ COMPLETE 2026-05-17, commit `9bebdf3`)

- [x] Init `~/echoly-server/` repo with Wrangler, TypeScript, Hono
- [x] D1 database `echoly` created (id `6ff8a3da-c035-4fa0-8071-919fa468f9f4`)
- [x] Migration 0001 applied locally (10 tables: users, sessions, magic_links, subscriptions, usage_events, usage_summary, partners, commission_events, email_log, webhook_events)
- [x] Domain `echolyhq.com` registered (Namecheap, 2yr) + CF zone active + Email Routing enabled with `hi@` → `sonxpiaz@gmail.com` forward
- [x] Stripe account "Echoly" created under Affitor LLC EIN, statement descriptor `ECHOLY`, branding updated
- [x] Smoke test: `/health` returns 200 OK

### Day 2 — Auth + Proxy + Usage (✅ COMPLETE 2026-05-17, commits `fc04b0e`, `a6dc35d`)

- [x] Magic-link auth wired with Resend (verified affitor.com sender for dev, mail.echolyhq.com pending Day 4)
- [x] Session cookie + bearer token both accepted (extension + dashboard share)
- [x] `POST /v1/proxy/*` Kyma forward with master key, classified per subpath
- [x] FUP enforcement: hard-block 402 with `quota_exhausted` (free/pro/max caps from `lib/fup.ts`)
- [x] Usage event D1 batch (event insert + summary upsert in single round-trip)
- [x] `X-Echoly-Usage` response header so extension renders cap state without follow-up call
- [x] `GET /v1/usage` returns standard + realtime monthly state
- [x] `GET /v1/affiliate/ref-cookie` returns ec_ref cookie value
- [x] Token replay protection (consumed_at marker)
- [x] 15/15 endpoint tests pass end-to-end
- [ ] Extension manifest update + content.js KYMA_BASE swap — deferred to Day 4-5 (extension ships first, server hookup once Stripe live)

### Day 3 — Billing + Affiliate (✅ CODE COMPLETE 2026-05-19)

- [x] Stripe Checkout endpoint `POST /v1/billing/checkout` — auth-gated, customer cache, metadata + tax + promo codes
- [x] Stripe Customer Portal endpoint `POST /v1/billing/portal` — 400 if no customer on file
- [x] Webhook handlers for all 6 events (`checkout.session.completed`, `customer.subscription.{created,updated,deleted}`, `invoice.payment_{succeeded,failed}`) — idempotent via `webhook_events` PK, Web-Crypto signature verify (`constructEventAsync`)
- [x] Affiliate cookie capture: `GET /v1/affiliate/ref-cookie` (Day 2 shipped)
- [ ] Extension: fetch ref cookie on install, store in chrome.storage — **deferred to Day 4** alongside extension subscription-mode wiring (depends on echolyhq.com landing setting the cookie cross-domain)
- [x] Stripe metadata flow: extension → checkout → webhook → commission_event — backend complete; extension producer Day 4
- [x] Affitor API integration: `postCommission()` with graceful fallback (rows stay `posted_to_affitor_at = NULL` when key/endpoint not configured — Day-5 cron retries pending)
- [ ] Test: full signup → upgrade → cancel flow — **blocked on Son's manual Stripe dashboard prereqs** (4 price IDs + webhook secret). Smoke tests pass (`/health` + all 4 routes return correct error codes without secrets). See `echoly-server/README.md` "Day 3 — Stripe manual prereqs" + "Stripe CLI smoke test" sections.

### Day 4 — Dashboard + Emails (8h)

- [ ] Init `~/echoly-web/` Astro project, CF Pages deploy
- [ ] Landing page `/` with pricing table + Stripe Checkout buttons
- [ ] Signin page `/signin` magic link form
- [ ] Account page `/account` with subscription + usage UI
- [ ] Affiliate page `/affiliate` with apply form
- [ ] Email templates: welcome, usage_80, usage_100, payment_failed, subscription_ended
- [ ] Privacy policy + Terms of service draft
- [ ] Test: visual QA all pages, email rendering in Gmail/Outlook

### Day 5 — Polish + Launch Prep (8h)

- [ ] Onboarding flow: extension banner on first YT visit post-install
- [ ] Quota modal UI in content.js with Upgrade/BYOK/Cancel buttons
- [ ] 90% / 100% usage email automation (Cloudflare Cron Trigger)
- [ ] Slack alert webhook integration
- [ ] Admin dashboard at echolyhq.com/admin (Son-only)
- [ ] CAL launch post Vietnamese draft
- [ ] FOUNDER100 promo code in Stripe + landing banner
- [ ] End-to-end test: 1 partner pilot, 1 organic user
- [ ] Tag v1.0.0 on extension + server + web repos

### Time buffers

Each day estimate has 1h buffer (so 7h actual + 1h debug). If Son focuses 10-12h/day, can finish in 3 days. Otherwise 5 days realistic.

---

## 20. Open questions / decisions pending

| # | Question | Default if not answered |
|---|---|---|
| 1 | ~~Domain ownership~~ | ✅ `echolyhq.com` registered 2026-05-17 via Namecheap (2yr, $26.66). CF zone active. |
| 2 | ~~Stripe account architecture~~ | ✅ Dedicated Echoly Stripe account under Affitor LLC EIN. Created 2026-05-17 (acct_1TYC9YBN17zRaxu4). Test mode active. |
| 3 | Affitor API endpoints exist or need building? | ⏳ Day 3 morning: ping Affitor team. Fallback: D1 commission_events table + CSV export. |
| 4 | ~~Resend account~~ | ✅ Reused kyma-api/.env RESEND_API_KEY (same Affitor LLC umbrella, both `affitor.com` + `kymaapi.com` verified). Day 4: verify `mail.echolyhq.com` to swap sender. |
| 5 | Privacy policy + ToS: draft them ourselves or use legal template (TermsFeed $100)? | Draft + TermsFeed if time. Existing privacy at sonpiaz.github.io/echoly works for Stripe approval interim. |
| 6 | ~~Support email~~ | ✅ `hi@echolyhq.com` set up via CF Email Routing → forward `sonxpiaz@gmail.com`. Test email delivered successfully 2026-05-17. |
| 7 | Free tier 30 min/mo — quota too low/high? | ⏳ Ship 30 min, measure conversion in first 100 free signups, adjust if drop-off > 80%. |
| 8 | Currency: USD only, or VND for VN users? | ✅ USD only v1 (Stripe Tax auto-handles VAT/sales). |
| 9 | Trial period for paid tiers? | ✅ No trial v1 (free tier 30 min/mo serves this role). |
| 10 | Annual subscription discount: 18% Pro / 30% Max locked, or A/B test? | ✅ Locked. Revisit Q3 after 90-day cohort data. |

---

## 21. Reference links

- Better-Auth: https://better-auth.com
- Cloudflare Workers + D1: https://developers.cloudflare.com/d1/
- Stripe Subscriptions: https://stripe.com/docs/billing/subscriptions/overview
- Stripe Checkout: https://stripe.com/docs/payments/checkout
- Stripe Customer Portal: https://stripe.com/docs/customer-management
- Resend: https://resend.com/docs
- Affitor API (internal docs TBD)
- Kyma API: existing `~/kyma-api/`
- claudekit.cc affiliate pattern: memory `reference_claudekit_affiliate_pattern`

---

## 22. Sign-off

This spec is the source of truth for the Echoly subscription system v1.0. Any deviation during implementation MUST be either:
1. Updated in this spec with rationale, OR
2. Documented as a known divergence in `~/echoly-server/DEVIATIONS.md`

---

## 23. Current implementation status (2026-05-17 EOD)

### Infrastructure live

| Asset | Status | Identifier |
|---|---|---|
| Domain | ✅ Active | `echolyhq.com` (Namecheap, 2yr) |
| CF Zone | ✅ Active (Free plan) | Zone ID `b954157db1e915fb7585cd7597801eb6` |
| CF Account | — | `6fe1dbea64688b15195a59129297754c` |
| D1 Database | ✅ Created + migrated | `echoly` (`6ff8a3da-c035-4fa0-8071-919fa468f9f4`) |
| CF Email Routing | ✅ Active | `hi@echolyhq.com` → `sonxpiaz@gmail.com` |
| Stripe Account | ✅ Test mode active | `acct_1TYC9YBN17zRaxu4` (Echoly under Affitor LLC EIN) |
| Resend Domains | ✅ `affitor.com` + `kymaapi.com` verified | Reuse kyma-api API key |
| Workers Dev Server | ✅ Running locally | `http://localhost:8787` |

### Repos

| Repo | Status | URL |
|---|---|---|
| `~/echoly/` (extension) | v0.5.2 in Chrome Web Store review | github.com/sonpiaz/echoly (public) |
| `~/echoly-server/` (backend) | Day 1-2 commits pushed | github.com/sonpiaz/echoly-server (private) |
| `~/echoly-web/` (dashboard) | Not started | — (Day 4) |

### What works end-to-end (verified 2026-05-17)

- Magic-link signup: `POST /auth/sign-in/magic-link` → email arrives at Gmail via Resend + CF forwarding → callback consumes token → session cookie set → 302 redirect.
- `/auth/me` returns signed-in user with tier.
- `/v1/usage` returns Free tier quota (30 min standard, 0 realtime).
- `/v1/proxy/*` rejects unauthenticated (401), forwards authed requests to Kyma with master key (smoke-tested with audio/understand — Kyma returned expected 400 for missing file).
- Token replay protection works (second use of magic link returns `token_consumed`).
- Affiliate ref cookie capture working.

### What's NOT yet implemented (Day 3-5)

- Stripe Checkout, Customer Portal, webhook handlers — Day 3
- Affitor commission POST integration — Day 3
- Extension subscription mode wiring (popup Sign-in UI, KYMA_BASE swap) — Day 4
- `~/echoly-web/` landing + dashboard — Day 4
- Email automation (90%/100% usage warnings via Cron) — Day 5
- Production deploy (`wrangler deploy --env production`) — Day 5
- Soft launch via Cơm AI Lò — Day 5+

### Day 3 prereqs (Son)

1. Stripe Echoly dashboard: create 4 Products + Prices (Pro/Max × monthly/annual) with `metadata.product=echoly` + `statement_descriptor_suffix=ECHOLY SUB`. Copy 4 `price_xxx` IDs to `.dev.vars`.
2. Affitor team: confirm `POST /v1/merchants/echoly/commissions` endpoint readiness (fallback to D1 CSV export if not).
