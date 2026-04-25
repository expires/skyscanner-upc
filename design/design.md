# Roam — powered by Skyscanner
> Passive travel intent detection + behavioural interest scoring for Instagram and TikTok web.

## What's New in V3

V1: Detected travel content from captions.
V2: Added live Skyscanner flight prices + wishlist.
V3: Adds behavioural engagement tracking — Roam now measures how long you actually pay attention to each destination and ranks them by real interest, not just detection count.

---

## Core Concept

> You don't know you want to go to Japan. But you've spent 4 minutes watching Japan reels, paused on 7 posts, and turned the sound on twice. Roam knows before you do.

Instead of inferring intent from a single post, V3 measures revealed preference through actual scrolling behaviour — dwell time, rewatches, sound activation, profile clicks, hashtag clicks — and produces a quantified interest score per destination.

---

## How It Works (Full V3 Flow)

```
User scrolling Instagram/TikTok in browser
        ↓
[content.ts] DOM watcher detects travel post
  - Extracts caption, hashtags, location tags
  - Starts engagement timer for this post
        ↓
[content.ts] Engagement tracker runs in parallel
  - Measures dwell time (ms on this post)
  - Detects: rewatch, sound toggle, profile click, hashtag click, scroll-back
  - Emits EngagementEvent to background on scroll-away or navigation
        ↓
[background.ts] receives two streams:
  Stream A: DetectionPayload → Claude API → destination + vibes
  Stream B: EngagementEvent → scoring engine → updates interest score
        ↓
[storage] chrome.storage.local maintains:
  - destinations: WishlistEntry[]
  - engagementLog: EngagementEvent[]
  - interestScores: InterestScore[]
        ↓
[popup.ts] three tabs:
  Feed    → live detections with flight prices (existing)
  Ranked  → destinations sorted by interest score with breakdown
  Saved   → starred wishlist (existing)
```

---

## File Structure

```
roam-extension/
├── manifest.json
├── popup.html
├── tsconfig.json
├── package.json
├── src/
│   ├── content.ts          # DOM watcher + engagement tracker
│   ├── background.ts       # Claude API + scoring engine + Skyscanner
│   ├── popup.ts            # UI logic for all three tabs
│   ├── scorer.ts           # Interest scoring algorithm (pure function)
│   └── types.ts            # All shared interfaces
└── dist/                   # Compiled output
```

---

## Data Models

```typescript
// types.ts

export interface DetectionPayload {
  text: string;           // raw caption + hashtags
  url: string;
  platform: 'instagram' | 'tiktok';
  postId: string;         // unique identifier for deduplication
}

export interface DetectionResult {
  isTravel: boolean;
  destination: string | null;
  country: string | null;
  countryCode: string | null;
  iataCode: string | null;  // Claude resolves city → IATA
  vibes: string[];          // max 3
}

export type EngagementEventType =
  | 'dwell'           // time spent on post (duration in ms)
  | 'rewatch'         // scrolled back to same post
  | 'sound_on'        // unmuted video
  | 'profile_click'   // tapped into creator profile
  | 'hashtag_click'   // clicked a destination hashtag
  | 'scroll_back';    // paused mid-scroll to return

export interface EngagementEvent {
  destination: string;      // resolved destination name
  countryCode: string;
  eventType: EngagementEventType;
  duration?: number;        // ms — used for dwell events only
  postId: string;
  platform: 'instagram' | 'tiktok';
  timestamp: number;
}

export interface InterestScore {
  destination: string;
  country: string;
  countryCode: string;
  score: number;            // 0–100 normalised
  rawScore: number;         // pre-normalisation weighted sum
  breakdown: {
    totalDwell: number;     // ms
    rewatches: number;
    soundOns: number;
    profileClicks: number;
    hashtagClicks: number;
    postCount: number;      // unique posts detected
  };
  lastUpdated: number;      // timestamp
}

export interface FlightResult {
  price: number;
  currency: string;
  airline: string;
  duration: string;         // e.g. "3h 45m"
  deeplink: string;
}

export interface WishlistEntry {
  id: string;
  destination: string;
  country: string;
  countryCode: string;
  vibes: string[];
  flight: FlightResult | null;
  interestScore: number;    // snapshot at time of save
  sourceUrl: string;
  platform: 'instagram' | 'tiktok';
  savedAt: number;
}
```

---

## Scoring Algorithm

```typescript
// scorer.ts

const WEIGHTS = {
  dwell: 0.5,           // per second of dwell time
  rewatch: 15,          // flat bonus per rewatch
  sound_on: 10,         // flat bonus
  profile_click: 25,    // flat bonus — high intent signal
  hashtag_click: 20,    // flat bonus
  scroll_back: 12,      // flat bonus
};

const DECAY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function calculateRawScore(events: EngagementEvent[]): number {
  const now = Date.now();
  return events.reduce((total, event) => {
    // time decay — older engagement counts less
    const age = now - event.timestamp;
    const decayFactor = Math.pow(0.5, age / DECAY_HALF_LIFE_MS);

    if (event.eventType === 'dwell' && event.duration) {
      return total + (event.duration / 1000) * WEIGHTS.dwell * decayFactor;
    }
    return total + WEIGHTS[event.eventType] * decayFactor;
  }, 0);
}

export function normaliseScores(scores: Map<string, number>): Map<string, number> {
  // normalise all destinations to 0–100 relative to each other
  const max = Math.max(...scores.values());
  if (max === 0) return scores;
  const normalised = new Map<string, number>();
  scores.forEach((raw, dest) => {
    normalised.set(dest, Math.round((raw / max) * 100));
  });
  return normalised;
}
```

**Key design decisions:**
- Time decay — engagement from 3 weeks ago matters less than today
- Normalised scores — scores are relative to each other, not absolute
- Dwell is continuous (per second), all others are discrete bonuses
- Profile click weighted highest — clearest signal of genuine interest

---

## Engagement Tracking Implementation

```typescript
// content.ts — engagement tracker additions

class EngagementTracker {
  private currentPostId: string | null = null;
  private currentDestination: string | null = null;
  private dwellStart: number | null = null;
  private observer: IntersectionObserver;

  constructor() {
    this.observer = new IntersectionObserver(this.handleVisibility, {
      threshold: 0.8  // post must be 80% visible to count dwell
    });
  }

  trackPost(postElement: Element, postId: string, destination: string) {
    // flush previous post dwell before starting new one
    this.flushDwell();
    this.currentPostId = postId;
    this.currentDestination = destination;
    this.dwellStart = Date.now();
    this.observer.observe(postElement);
  }

  private handleVisibility = (entries: IntersectionObserverEntry[]) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) {
        this.flushDwell();  // post scrolled away
      }
    });
  }

  private flushDwell() {
    if (this.dwellStart && this.currentDestination && this.currentPostId) {
      const duration = Date.now() - this.dwellStart;
      if (duration > 1500) {  // only count if viewed for >1.5s
        this.emitEvent({
          eventType: 'dwell',
          duration,
          destination: this.currentDestination,
          postId: this.currentPostId,
        });
      }
      this.dwellStart = null;
    }
  }

  trackSoundToggle(postId: string, destination: string) {
    this.emitEvent({ eventType: 'sound_on', postId, destination });
  }

  trackProfileClick(postId: string, destination: string) {
    this.emitEvent({ eventType: 'profile_click', postId, destination });
  }

  private emitEvent(partial: Partial<EngagementEvent>) {
    chrome.runtime.sendMessage({
      type: 'ENGAGEMENT_EVENT',
      payload: {
        ...partial,
        countryCode: this.resolveCountryCode(partial.destination),
        platform: this.detectPlatform(),
        timestamp: Date.now(),
      }
    });
  }
}
```

---

## Claude API Prompt (unchanged from V2)

```
You are a travel content detector. Given social media post text, determine if it contains travel content.

Respond ONLY with valid JSON, no markdown, no preamble:
{
  "isTravel": boolean,
  "destination": string | null,
  "country": string | null,
  "countryCode": string | null,
  "iataCode": string | null,
  "vibes": string[]
}

Rules:
- iataCode must be the nearest major airport IATA code for the destination
- vibes: max 3, short labels e.g. "Beach", "Budget-friendly", "Temples", "Nightlife"
- If not travel content, return isTravel: false and null for all other fields

Post text: {TEXT}
```

---

## Popup UI — V3 Changes

### Tab: Ranked (new)

```
┌─────────────────────────────────────────┐
│  Your Travel DNA          last 30 days  │
├─────────────────────────────────────────┤
│  🇯🇵 Japan          ████████░░  82      │
│     4m 20s dwell · 2 rewatches          │
│     £680 · Japan Airlines · 14h 30m  ↗  │
├─────────────────────────────────────────┤
│  🇵🇹 Azores         ██████░░░░  61      │
│     2m 10s dwell · 1 profile click      │
│     £265 · Azores Airlines · 3h 45m  ↗  │
├─────────────────────────────────────────┤
│  🇵🇭 Palawan        ███░░░░░░░  31      │
│     55s dwell                           │
│     £1119 · Qatar Airways · 21h 25m  ↗  │
└─────────────────────────────────────────┘
```

Each row shows:
- Country flag + destination name
- Visual score bar (0–100)
- Engagement breakdown (dwell time, rewatches, clicks)
- Cheapest flight inline
- Arrow deeplinks to Skyscanner

### Tab: Feed (existing, minor update)
- Add small interest score badge to each detection card
- Shows score momentum: "↑ score increasing" if engaged recently

### Tab: Saved (existing, unchanged)

---

## Manifest V3 Updates

```json
{
  "manifest_version": 3,
  "name": "Roam",
  "version": "0.3.0",
  "description": "Passive travel intent detection powered by Skyscanner",
  "permissions": ["storage", "activeTab", "tabs"],
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
    "matches": [
      "https://www.tiktok.com/*",
      "https://www.instagram.com/*"
    ],
    "js": ["dist/content.js"],
    "run_at": "document_idle"
  }],
  "action": {
    "default_popup": "popup.html",
    "default_title": "Roam"
  }
}
```

---

## Message Types

```typescript
// All messages between content.ts ↔ background.ts

type MessageType =
  | { type: 'DETECTION_PAYLOAD'; payload: DetectionPayload }
  | { type: 'ENGAGEMENT_EVENT'; payload: EngagementEvent }
  | { type: 'GET_SCORES'; }
  | { type: 'CLEAR_ALL'; };

type ResponseType =
  | { type: 'DETECTION_RESULT'; payload: DetectionResult & { flight: FlightResult | null } }
  | { type: 'SCORES_RESULT'; payload: InterestScore[] };
```

---

## Storage Schema

```typescript
// chrome.storage.local keys

interface StorageSchema {
  'roam:destinations': WishlistEntry[];     // feed detections
  'roam:wishlist': WishlistEntry[];         // starred items
  'roam:engagement': EngagementEvent[];     // raw event log
  'roam:scores': InterestScore[];           // computed scores cache
  'roam:settings': {
    homeAirport: string;                    // e.g. "BCN"
    currency: string;                       // e.g. "GBP"
    anthropicKey: string;
    skyscannerKey: string;
  };
}
```

---

## Implementation Order for Claude Code

Implement in this exact order — each step builds on the last:

1. `types.ts` — all interfaces, no logic
2. `scorer.ts` — pure scoring functions, unit testable
3. `content.ts` — add EngagementTracker class alongside existing DOM watcher
4. `background.ts` — add ENGAGEMENT_EVENT handler, score recomputation on each event
5. `popup.ts` — add Ranked tab UI, update Feed tab with score badges
6. `popup.html` — add third tab button

Do not modify existing V2 detection or Skyscanner logic — add alongside it.

---

## Skyscanner Track Pitch

> "Most travel apps ask what you want. Roam watches what you actually stop for."

Roam addresses Skyscanner's brief directly:
- **Understands traveller intent** — behavioural signals, not self-reported preferences
- **Not a chatbot** — completely silent, no interaction required
- **Cuts through complexity** — one ranked list, best flight inline, one tap to book
- **Preserves control** — user sees exactly why each destination is ranked, full transparency
- **Novel** — none of the anti-patterns Skyscanner listed

---

## Demo Script (judging)

1. Open Instagram, scroll Reels naturally for 60 seconds
2. Open Roam popup → Feed tab shows detected destinations with live prices
3. Switch to Ranked tab → show interest scores building in real time
4. Point to score breakdown: "4 minutes on Japan reels, 2 rewatches — Roam ranked it #1"
5. Click Skyscanner deeplink → live flight results open
6. One sentence close: "You didn't search for Japan. You just watched it."