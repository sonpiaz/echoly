# Echoly — Chrome Web Store submission metadata

Drop these strings into the Web Store form fields exactly. Lengths checked against current limits (description 16,000; short description 132).

---

## Name (50 char max)

```
Echoly — Live YouTube Translation
```

## Short description (132 char max)

```
Hear any YouTube video in your language. Live AI dubbing — pick voice + language, runs on your own Kyma key, no signup.
```

(118 / 132 char)

## Category

`Productivity` — primary. (Accessibility is also valid; pick whichever you think gets better discovery for your audience.)

## Language

`English (United States)` — UI is English. You can add Vietnamese later as a localized listing.

## Long description (16,000 char max — using ~1,400)

```
Echoly turns any YouTube video into a live dub in the language you understand best. Click the icon, pick a voice and a target language, press Start. The translated voice plays back over the video with sub-second lag in Realtime mode, ~5 seconds in Standard mode.

Why Echoly is different
• No account, no signup. You bring a Kyma API key (kymaapi.com) and the extension runs on your own balance.
• Two tiers — pick what fits the moment.
   - Realtime · sub-second lag · clones the speaker's voice or picks from 9 OpenAI voices · ~$0.46 per 10 minutes.
   - Standard · ~5s lag · 5 curated MiniMax voices, all multilingual · ~$0.25 per 10 minutes.
• 13 target languages: English, Vietnamese, Japanese, Korean, Chinese, French, Spanish, German, Portuguese, Hindi, Indonesian, Italian, Russian.
• Live source captions side-by-side with the dub if you want to follow along.
• Translation history — last 16 turns, scrollable.
• Independent volume control for the original audio and the dub.
• In-page panel you can drag, resize, hide.
• Pause/play the YouTube video and the dub follows instantly. No reconnect.
• 60-minute hard auto-stop with a 5-minute warning so you don't accidentally leave it running.
• Sessions end cleanly when you close the tab.

What it's good for
• Watching keynotes, talks, and product launches in your native language without waiting for human subs.
• Following long-form interviews, podcasts, and lectures faster than reading captions.
• Practicing a language by listening to native English content with a parallel dub.

How it works
Standard tier sends short audio chunks to Kyma, which routes through Whisper for transcription, Gemini for translation, and MiniMax for the voice. Realtime tier opens a peer-to-peer WebRTC connection to OpenAI Realtime via a Kyma-minted ephemeral token — your audio never round-trips through any other server.

What it doesn't do
• No account creation. No telemetry. No analytics. No data stored on Echoly's side — see our privacy policy.
• Not a download tool. Echoly does not save audio, transcripts, or videos to your disk.

Get a Kyma key at kymaapi.com. Free starter credit on signup; pay-as-you-go after that.
```

(1,393 / 16,000 char)

## Single purpose statement (mandatory)

```
Echoly translates the audio of the YouTube video on the active tab into a language the user picks, and plays the translation back as a live voice-over. That is its sole purpose.
```

## Permission justifications (each ≤ 1,000 char; reviewers read these closely)

### `activeTab`
```
Used so that when the user clicks the Echoly toolbar icon and presses Start, the extension can run a content script on the YouTube tab they are looking at. We do not act on tabs the user has not explicitly invoked us on.
```

### `scripting`
```
Used by the background service worker to inject the content script into a YouTube tab that already existed before the extension was installed or reloaded. Without this, Start would only work after a tab refresh. We inject only into tabs whose URL is on youtube.com (verified before injection) and only after the user clicks Start.
```

### `storage`
```
Used to remember the user's Kyma API key and their preferences (tier, target language, voice, volume, source-caption toggle) across sessions. The Kyma key is stored at TRUSTED_CONTEXTS access level so that page scripts on youtube.com cannot read it. We do not store any video, audio, transcript, or browsing history.
```

### `host_permissions: https://*.youtube.com/*` and `https://youtube.com/*`
```
Required to capture the audio of the YouTube video the user is watching via HTMLMediaElement.captureStream() and to render the translation overlay panel on the page. We never modify YouTube content, never read user account data, and never make requests to YouTube's API.
```

### `host_permissions: https://api.kymaapi.com/*`
```
Required to send the captured audio to the Kyma API gateway for transcription, translation, and text-to-speech. The user's Kyma API key authenticates each request. Kyma is the user's own paid account; the extension does not proxy through any Echoly-operated server.
```

### `host_permissions: https://api.openai.com/*`
```
Required only by the Realtime tier. After Kyma mints a short-lived ephemeral token, the extension opens a peer-to-peer WebRTC connection directly with OpenAI Realtime so that audio is processed end-to-end with sub-second latency. The user's Kyma API key is never sent to OpenAI; only the ephemeral token is.
```

## Data usage disclosures (Web Store form checkboxes)

When the form asks "Does this extension collect or use any user data?":

- ✅ Yes (because audio is processed by third-party providers under the user's account)

When asked "What types of user data?":

- ✅ Personally identifiable information → **NO**
- ✅ Health information → **NO**
- ✅ Financial and payment information → **NO**
- ✅ Authentication information → **YES** (the user's Kyma API key, stored locally, sent only to Kyma)
- ✅ Personal communications → **NO**
- ✅ Location → **NO**
- ✅ Web history → **NO**
- ✅ User activity → **YES** (audio of the video the user is currently watching is sent to AI providers for the purpose of translation, then discarded)
- ✅ Website content → **NO**

When asked "How is the data used?":

- ✅ Authenticating the user (the API key)
- ✅ Providing the core feature of the extension (the audio translation)

Required certifications:

- ✅ I do not sell or transfer user data to third parties, outside the approved use cases.
- ✅ I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- ✅ I do not use or transfer user data to determine creditworthiness or for lending purposes.

## Privacy policy URL

Host `store-assets/privacy-policy.html` somewhere stable. Suggested: `https://sonpiaz.com/echoly/privacy` or a static Vercel project.

Once hosted, paste the URL into the Web Store form's "Privacy policy" field.

## Test instructions for reviewer (under "Account" tab in the form)

```
Echoly requires a Kyma API key to function. To test:

1. Sign up for a free account at https://kymaapi.com (free starter credit included).
2. Copy the API key from the dashboard.
3. Open any English-language YouTube video.
4. Click the Echoly icon, paste the key, leave defaults (Realtime tier, Vietnamese, Marin voice).
5. Press Start. Within ~2 seconds the dub should begin.

If you'd prefer a pre-loaded test key, please email sonxpiaz@gmail.com and I'll provide one for the duration of the review.
```

## Visibility

`Public` (after approval). Submit for review when all fields are green.
