# Wander — Browser Extension

> Passive travel intent detection for TikTok and Instagram web. Powered by Claude AI + Skyscanner.

## What It Does

Wander runs in the background while you scroll social media. When it detects travel content, it extracts the destination and surfaces live flight prices — without you leaving the page or opening another app.

No forms. No chatbots. No friction.

---

## How It Works

```
User scrolling TikTok/Instagram in browser
        ↓
Content script watches DOM for video descriptions,
hashtags, captions, and location tags
        ↓
Background service worker sends extracted text
to Claude API (claude-haiku-4-5-20251001)
        ↓
Claude determines:
  - Is this travel content? (boolean)
  - Destination name + country
  - Vibe tags (max 3, e.g. "Beach", "Budget", "Temples")
        ↓
If travel detected → fetch Skyscanner API for
cheapest flight from user's home airport
        ↓
Extension popup updates with:
  - Destination name + country flag
  - Vibe tags
  - Cheapest flight price + airline
  - "Save to Wishlist" button
        ↓
Saved destinations stored in chrome.storage.local
```

---

## File Structure

```
wander-extension/
├── manifest.json          # Manifest V3 config
├── popup.html             # Extension popup UI
├── tsconfig.json          # TypeScript config
├── package.json
├── src/
│   ├── content.ts         # DOM watcher — runs on TikTok/Instagram
│   ├── background.ts      # Service worker — Claude API + Skyscanner calls
│   ├── popup.ts           # Popup UI logic
│   └── types.ts           # Shared TypeScript interfaces
└── dist/                  # Compiled JS output (gitignored)
```

---

## Architecture

### Content Script (`content.ts`)
- Runs on `tiktok.com/*` and `instagram.com/*`
- Watches DOM mutations for video description changes
- Extracts: description text, hashtags, location tag, page URL
- Debounces at 1500ms to avoid spamming on fast scrolls
- Sends extracted payload to background via `chrome.runtime.sendMessage`

### Background Service Worker (`background.ts`)
- Receives content payloads from content script
- Calls Claude API with extracted text
- If travel detected, calls Skyscanner API for flight price
- Sends result back to popup via `chrome.storage.local` update
- Handles API key storage via `chrome.storage.sync`

### Popup (`popup.ts` + `popup.html`)
- Displays current detection result
- Shows destination, vibe tags, flight price
- Save button writes to wishlist in `chrome.storage.local`
- Wishlist tab shows all saved destinations

---

## Claude API Prompt

```
You are a travel content detector. Given social media post text, determine if it contains travel content.

Respond ONLY with valid JSON, no markdown, no explanation:
{
  "isTravel": boolean,
  "destination": string | null,
  "country": string | null,
  "countryCode": string | null,
  "vibes": string[]  // max 3, e.g. ["Beach", "Budget-friendly", "Temples"]
}

Post text: {TEXT}
```

---

## Data Models

```typescript
interface DetectionResult {
  isTravel: boolean;
  destination: string | null;
  country: string | null;
  countryCode: string | null;
  vibes: string[];
}

interface FlightResult {
  price: number;
  currency: string;
  airline: string;
  deeplink: string;
}

interface WishlistEntry {
  id: string;
  destination: string;
  country: string;
  countryCode: string;
  vibes: string[];
  flight: FlightResult | null;
  sourceUrl: string;
  savedAt: number; // timestamp
}
```

---

## Manifest V3 Config

```json
{
  "manifest_version": 3,
  "name": "Wander",
  "version": "0.1.0",
  "description": "Passive travel intent detection powered by AI",
  "permissions": ["storage", "activeTab"],
  "host_permissions": [
    "https://www.tiktok.com/*",
    "https://www.instagram.com/*",
    "https://partners.api.skyscanner.net/*",
    "https://api.anthropic.com/*"
  ],
  "background": {
    "service_worker": "dist/background.js",
    "type": "module"
  },
  "content_scripts": [{
    "matches": ["https://www.tiktok.com/*", "https://www.instagram.com/*"],
    "js": ["dist/content.js"],
    "run_at": "document_idle"
  }],
  "action": {
    "default_popup": "popup.html",
    "default_title": "Wander"
  }
}
```

---

## API Keys

Stored in `chrome.storage.sync` — set via extension options page:
- `ANTHROPIC_API_KEY` — Anthropic console
- `SKYSCANNER_API_KEY` — provided at hackathon opening ceremony
- `HOME_AIRPORT` — user's departure IATA code (e.g. "BCN", "GLA", "LHR")

---

## Build

```bash
npm install
npm run build       # tsc → dist/
npm run watch       # tsc --watch for development
```

Load unpacked in Arc/Chrome:
```
arc://extensions → Developer mode → Load unpacked → select project root
```

---

## Skyscanner Integration

Target endpoint: `GET /apiservices/v3/flights/live/search/create`

Key params:
- `originLocationCode` — user's home airport
- `destinationLocationCode` — detected destination airport (Claude resolves city → IATA)
- `departureDate` — next available weekend or user preference
- `currency` — EUR (Barcelona context)

Fallback: If Skyscanner API keys not available at hackathon, mock with static price data to keep demo functional.

---

## Supported Sites

| Site | Detection Method |
|---|---|
| TikTok web | `[data-e2e="browse-video-desc"]` + hashtag spans |
| Instagram Reels | Caption text under video player |

---

## Hackathon Track

**Primary: Skyscanner** — "Next-generation AI travel experience that understands traveller intent"

This project addresses their brief directly:
- Natural language intent understanding (Claude API)
- Discovery over booking — surfaces destinations before user actively searches
- No chatbot, no forms, no group trip planner
- Preserves user control — passive detection, explicit save action

---

## Roadmap (post-hackathon)

- iOS Share Extension feeding same wishlist (Swift + FoundationModels)
- Dynamic Island price drop alerts
- Safari extension via Xcode converter
- YouTube support