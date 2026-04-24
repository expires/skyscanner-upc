# Roam — Implementation Context & Findings

## Architecture Decisions

### No Anthropic SDK — raw fetch instead
Chrome extension service workers run in a limited environment. The `@anthropic-ai/sdk` package relies on Node.js APIs (`node:stream`, `http`) that aren't available in MV3 service workers. We use `fetch()` directly against `https://api.anthropic.com/v1/messages` with the `anthropic-dangerous-direct-browser-access: true` header, which Anthropic requires for browser-based calls.

### ES Modules for service worker
Manifest V3 service workers support `"type": "module"`. We compile to ES2020 modules (`"module": "ES2020"` in tsconfig) so that `import`/`export` works natively. Content scripts also load as modules. All inter-file imports use `.js` extensions (required for browser module resolution even when source is `.ts`).

### Skyscanner API fallback to mock data
The design spec notes Skyscanner API keys may not be available at the hackathon. `background.ts` implements a `getMockFlight()` fallback that returns deterministic but realistic-looking prices when the API key is empty or the API call fails. This keeps the demo fully functional without live API access.

### DOM selectors for TikTok / Instagram
- **TikTok**: `[data-e2e="browse-video-desc"]` for video descriptions, `a[href*='/tag/']` for hashtags, `[data-e2e="browse-video-location"]` for location tags.
- **Instagram**: More fragile — we chain-query `h1._ap3a`, `[class*="Caption"] span`, and `article span[dir='auto']`. Instagram obfuscates class names and changes them frequently, so these selectors may need updating.

### Debounce strategy
Content script debounces at 1500ms with deduplication (won't re-send identical text). This avoids hammering the Claude API when the user scrolls quickly through videos. The `MutationObserver` watches `childList`, `subtree`, and `characterData` on `document.body`.

## Key Technical Findings

### `anthropic-dangerous-direct-browser-access` header
Required when calling the Anthropic API directly from a browser context (not a server). Without this header, the API returns a 403. This is by design — Anthropic wants developers to acknowledge they're exposing their API key client-side. For a hackathon demo this is acceptable; for production, a proxy server would be needed.

### Chrome Storage split
- `chrome.storage.sync` — API keys and home airport (persists across devices if user is signed into Chrome)
- `chrome.storage.local` — detection state and wishlist (device-local, larger quota)

### Popup lifecycle
Chrome extension popups are destroyed when closed and recreated when opened. The popup reads current state from `chrome.storage.local` on open, and listens for `chrome.storage.onChanged` events to update in real-time if the background detects new travel content while the popup is open.

### Country flag rendering
We convert ISO 3166-1 alpha-2 codes to flag emoji using Unicode Regional Indicator Symbols (offset `0x1F1E6`). This avoids shipping flag images and works on all modern browsers.

### TypeScript `.js` imports
When targeting ES modules, TypeScript requires import paths to use `.js` extensions (e.g., `import { Foo } from "./types.js"`), even though the source files are `.ts`. This is because TS doesn't rewrite import specifiers — the compiled output needs valid paths for the browser's module loader.

## File Summary

| File | Purpose | Lines |
|---|---|---|
| `manifest.json` | MV3 config, permissions, content script registration | ~30 |
| `src/types.ts` | Shared interfaces (DetectionResult, FlightResult, etc.) | ~50 |
| `src/content.ts` | DOM watcher for TikTok + Instagram | ~100 |
| `src/background.ts` | Claude API + Skyscanner API + storage updates | ~200 |
| `src/popup.ts` | Popup UI logic, wishlist, settings | ~200 |
| `popup.html` | Popup markup + CSS (dark theme) | ~250 |

## Known Limitations

1. **Instagram selectors are fragile** — Instagram frequently changes class names. The current selectors target Reels captions but may break without notice.
2. **API key exposure** — Keys are stored in `chrome.storage.sync` and sent from the service worker. Acceptable for hackathon; production would need a backend proxy.
3. **Skyscanner destination resolution** — Claude returns city names, but Skyscanner needs IATA codes or entity IDs. Currently we pass the destination name and rely on Skyscanner's fuzzy matching. A proper implementation would add an airport lookup step.
4. **No rate limiting** — If the user scrolls very fast through travel content, we could hit Claude API rate limits. The 1500ms debounce helps but isn't a guarantee.
