import {
  ContentPayload,
  DetectedEntry,
  DestinationHit,
  DetectionResult,
  FlightResult,
  StoredSettings,
} from "./types.js";

const CLAUDE_MODEL = "claude-haiku-4-5-20251001";
const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";

const CLAUDE_PROMPT = `You are a travel content detector analyzing social media content. You will be given post text and optionally a screenshot. Use BOTH the text and visual content to identify travel destinations.

Respond ONLY with valid JSON, no markdown, no explanation:
{
  "isTravel": boolean,
  "destinations": [
    {
      "destination": string,
      "country": string,
      "countryCode": string,
      "airportCode": string,
      "vibes": string[]
    }
  ]
}

Rules:
- "destination" means a CITY or REGION you would fly to — NOT individual landmarks, beaches, caves, or attractions within that city/region
- If a post shows multiple spots within the same city/region (e.g. Navagio Beach, Turtle Island, Eros Cave are all in Zakynthos), return ONE entry for the city/region (Zakynthos) with vibes that capture the highlights
- Only return multiple destinations if they are in genuinely DIFFERENT cities/regions with DIFFERENT airports (e.g. "Barcelona and Tokyo" = 2 destinations, "5 beaches in Bali" = 1 destination)
- Up to 5 destinations max
- Each destination must have: city/region name, country, countryCode (ISO 3166-1 alpha-2), airportCode (nearest major IATA), and up to 8 vibe/mood tags (e.g. "Beach", "Budget", "Nightlife", "Romantic", "Historic", "Adventure", "Food", "Scenic")
- Use the screenshot to identify destinations from landmarks, text overlays, or location pins even if the caption is vague
- If not travel content, set isTravel to false and destinations to []`;

// --- Settings ---

async function getSettings(): Promise<StoredSettings> {
  return (await chrome.storage.sync.get([
    "ANTHROPIC_API_KEY",
    "SKYSCANNER_API_KEY",
    "HOME_AIRPORT",
    "CURRENCY",
  ])) as StoredSettings;
}

// --- Tab capture ---

async function captureTab(windowId: number): Promise<string | null> {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
      format: "jpeg",
      quality: 60,
    });
    return dataUrl.split(",")[1] ?? null;
  } catch (e) {
    console.warn("[Roam BG] Tab capture failed:", e);
    return null;
  }
}

// --- Claude detection ---

async function detectTravel(
  text: string,
  screenshot: string | null,
  apiKey: string
): Promise<DetectionResult> {
  const content: any[] = [];

  if (screenshot) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: screenshot },
    });
  }

  content.push({
    type: "text",
    text: `${CLAUDE_PROMPT}\n\nPost text: ${text}`,
  });

  const response = await fetch(CLAUDE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      messages: [{ role: "user", content }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error: ${response.status} ${err}`);
  }

  const data = await response.json();
  let responseText = data.content?.[0]?.text ?? "{}";
  responseText = responseText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    return JSON.parse(responseText) as DetectionResult;
  } catch {
    // Response may be truncated — try to salvage by closing open arrays/objects
    console.warn("[Roam BG] JSON parse failed, attempting repair");
    // Find the last complete destination object by finding the last "},"
    const lastComplete = responseText.lastIndexOf("},");
    if (lastComplete > 0) {
      const repaired = responseText.slice(0, lastComplete + 1) + "]}";
      try {
        return JSON.parse(repaired) as DetectionResult;
      } catch {
        // Give up
      }
    }
    return { isTravel: false, destinations: [] };
  }
}

// --- Skyscanner ---

const SKYSCANNER_BASE =
  "https://partners.api.skyscanner.net/apiservices/v3/flights/live/search";
const MAX_POLLS = 5;
const POLL_DELAY_MS = 2000;

function buildSkyscannerQuery(homeAirport: string, destAirport: string, currency: string = "EUR") {
  return {
    query: {
      market: "ES",
      locale: "en-GB",
      currency,
      queryLegs: [
        {
          originPlaceId: { iata: homeAirport },
          destinationPlaceId: { iata: destAirport },
          date: getNextWeekendDate(),
        },
      ],
      adults: 1,
      cabinClass: "CABIN_CLASS_ECONOMY",
    },
  };
}

async function searchFlights(
  destAirport: string,
  homeAirport: string,
  apiKey: string,
  currency: string = "EUR"
): Promise<FlightResult | null> {
  if (!apiKey) return null;

  try {
    const createRes = await fetch(`${SKYSCANNER_BASE}/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify(buildSkyscannerQuery(homeAirport, destAirport, currency)),
    });

    if (!createRes.ok) {
      console.warn("[Roam BG] Skyscanner error", createRes.status, await createRes.text());
      return null;
    }

    let data = await createRes.json();
    const sessionToken = data.sessionToken;
    let polls = 0;

    while (data.status === "RESULT_STATUS_INCOMPLETE" && polls < MAX_POLLS && sessionToken) {
      await new Promise((r) => setTimeout(r, POLL_DELAY_MS));
      polls++;
      const pollRes = await fetch(`${SKYSCANNER_BASE}/poll/${sessionToken}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify(buildSkyscannerQuery(homeAirport, destAirport, currency)),
      });
      if (!pollRes.ok) break;
      data = await pollRes.json();
    }

    return parseSkyscannerResult(data, homeAirport, destAirport, currency);
  } catch (e) {
    console.warn("[Roam BG] Skyscanner fetch failed:", e);
    return null;
  }
}

function getItineraryPrice(itin: any): number {
  const raw = parseFloat(itin.pricingOptions?.[0]?.price?.amount ?? "Infinity");
  return raw > 1000 ? raw / 1000 : raw;
}

function getItineraryDuration(itin: any, legs: any): number {
  const legId = itin.legIds?.[0];
  if (!legId || !legs?.[legId]) return Infinity;
  return legs[legId].durationInMinutes ?? Infinity;
}

function parseSkyscannerResult(data: any, origin: string, dest: string, currency: string = "EUR"): FlightResult | null {
  const itineraries = data?.content?.results?.itineraries;
  if (!itineraries) return null;

  const legs = data?.content?.results?.legs;
  const carriers = data?.content?.results?.carriers;
  const entries = Object.values(itineraries) as any[];
  if (entries.length === 0) return null;

  const minPrice = Math.min(...entries.map((e) => getItineraryPrice(e)));
  const maxPrice = Math.max(...entries.map((e) => getItineraryPrice(e)));
  const minDur = Math.min(...entries.map((e) => getItineraryDuration(e, legs)));
  const maxDur = Math.max(...entries.map((e) => getItineraryDuration(e, legs)));
  const priceRange = maxPrice - minPrice || 1;
  const durRange = maxDur - minDur || 1;

  entries.sort((a: any, b: any) => {
    const sA = (getItineraryPrice(a) - minPrice) / priceRange + (getItineraryDuration(a, legs) - minDur) / durRange;
    const sB = (getItineraryPrice(b) - minPrice) / priceRange + (getItineraryDuration(b, legs) - minDur) / durRange;
    return sA - sB;
  });

  const best = entries[0];
  const pricing = best.pricingOptions?.[0];
  if (!pricing) return null;

  const price = Math.round(getItineraryPrice(best));
  const durationMinutes = getItineraryDuration(best, legs);

  let airlineName = "Unknown";
  const legId = best.legIds?.[0];
  if (legId && legs && carriers) {
    const leg = legs[legId];
    const carrierId = leg?.operatingCarrierIds?.[0] ?? leg?.marketingCarrierIds?.[0];
    if (carrierId) airlineName = carriers[carrierId]?.name ?? "Unknown";
  }

  const date = getNextWeekendDate();
  const dateStr = `${date.year}${String(date.month).padStart(2, "0")}${String(date.day).padStart(2, "0")}`;
  const fallbackLink = `https://www.skyscanner.net/transport/flights/${origin.toLowerCase()}/${dest.toLowerCase()}/${dateStr}/`;

  return {
    price,
    currency,
    airline: airlineName,
    durationMinutes: durationMinutes === Infinity ? 0 : Math.round(durationMinutes),
    deeplink: pricing.items?.[0]?.deepLink || fallbackLink,
  };
}

function getNextWeekendDate(): { year: number; month: number; day: number } {
  const now = new Date();
  const daysUntilFriday = (5 - now.getDay() + 7) % 7 || 7;
  const friday = new Date(now);
  friday.setDate(now.getDate() + daysUntilFriday);
  return { year: friday.getFullYear(), month: friday.getMonth() + 1, day: friday.getDate() };
}

// --- Storage helpers ---

const MAX_DETECTIONS = 50;
const MAX_VIBES = 8;

function mergeVibes(existing: string[], incoming: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const v of [...existing, ...incoming]) {
    const key = v.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(v);
    }
  }
  return merged.slice(0, MAX_VIBES);
}

async function addDetection(
  hit: DestinationHit,
  flight: FlightResult | null,
  sourceUrl: string
): Promise<void> {
  const { detections = [] } = (await chrome.storage.local.get("detections")) as { detections: DetectedEntry[] };

  // Match by exact name, same airport code, or one name containing the other
  const hitName = hit.destination.toLowerCase();
  const hitAirport = hit.airportCode?.toUpperCase();
  const existingIdx = detections.findIndex((d) => {
    const dName = d.destination.toLowerCase();
    if (dName === hitName) return true;
    if (hitAirport && d.airportCode?.toUpperCase() === hitAirport) return true;
    if (dName.includes(hitName) || hitName.includes(dName)) return true;
    return false;
  });

  const existing = existingIdx >= 0 ? detections[existingIdx] : null;

  // Keep the shorter/cleaner name (likely the city/region rather than a landmark)
  const bestName = existing
    ? (hit.destination.length <= existing.destination.length ? hit.destination : existing.destination)
    : hit.destination;

  const entry: DetectedEntry = {
    id: existing?.id ?? crypto.randomUUID(),
    destination: bestName,
    country: hit.country,
    countryCode: hit.countryCode,
    airportCode: hit.airportCode,
    vibes: mergeVibes(existing?.vibes ?? [], hit.vibes),
    flight: flight ?? existing?.flight ?? null,
    sourceUrl,
    detectedAt: Date.now(),
  };

  if (existingIdx >= 0) detections.splice(existingIdx, 1);
  detections.unshift(entry);
  if (detections.length > MAX_DETECTIONS) detections.length = MAX_DETECTIONS;

  await chrome.storage.local.set({ detections });
}

async function setLoading(destinations: string[]): Promise<void> {
  await chrome.storage.local.set({ loadingDestinations: destinations });
}

async function removeLoading(destination: string): Promise<void> {
  const { loadingDestinations = [] } = await chrome.storage.local.get("loadingDestinations");
  const updated = (loadingDestinations as string[]).filter(
    (d) => d.toLowerCase() !== destination.toLowerCase()
  );
  await chrome.storage.local.set({ loadingDestinations: updated });
}

// --- Global Skyscanner semaphore (max 5 concurrent flight searches) ---

const MAX_CONCURRENT_FLIGHTS = 5;
let activeFlights = 0;
const flightQueue: (() => void)[] = [];
const flightCache = new Map<string, FlightResult | null>();

function acquireFlightSlot(): Promise<void> {
  if (activeFlights < MAX_CONCURRENT_FLIGHTS) {
    activeFlights++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    flightQueue.push(() => {
      activeFlights++;
      resolve();
    });
  });
}

function releaseFlightSlot(): void {
  activeFlights--;
  const next = flightQueue.shift();
  if (next) next();
}

async function processDestination(
  hit: DestinationHit,
  sourceUrl: string,
  settings: StoredSettings
): Promise<void> {
  const airportCode = hit.airportCode;

  // Check cache first — no slot needed
  if (flightCache.has(airportCode)) {
    const cachedFlight = flightCache.get(airportCode) ?? null;
    await addDetection(hit, cachedFlight, sourceUrl);
    await removeLoading(hit.destination);
    return;
  }

  // Wait for a slot
  await acquireFlightSlot();
  try {
    // Double-check cache (another request may have filled it while we waited)
    if (flightCache.has(airportCode)) {
      await addDetection(hit, flightCache.get(airportCode) ?? null, sourceUrl);
      await removeLoading(hit.destination);
      return;
    }

    const flight = await searchFlights(
      airportCode,
      settings.HOME_AIRPORT || "BCN",
      settings.SKYSCANNER_API_KEY,
      settings.CURRENCY || "EUR"
    );

    flightCache.set(airportCode, flight);
    console.log(`[Roam BG] Flight for ${hit.destination}:`, flight ? `${flight.price} ${flight.currency} · ${flight.airline}` : "none");

    await addDetection(hit, flight, sourceUrl);
    await removeLoading(hit.destination);
  } finally {
    releaseFlightSlot();
  }
}

// --- Parallel processing indexed by postId:slideIndex ---

// Tracks which post+slide combos have been processed or are in-flight
const processedSlides = new Set<string>();

function slideKey(postId: string, slideIndex: number): string {
  return `${postId}:${slideIndex}`;
}

// Clear stale loading state on startup
chrome.storage.local.set({ loadingDestinations: [] });

async function processRequest(message: ContentPayload, windowId: number | undefined): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.ANTHROPIC_API_KEY) {
      console.warn("Roam: No Anthropic API key set.");
      return;
    }

    // Capture screenshot
    let screenshot: string | null = null;
    if (windowId) {
      screenshot = await captureTab(windowId);
    }

    const fullText = [message.description, ...message.hashtags, message.locationTag ?? ""]
      .filter(Boolean)
      .join(" ");

    console.log(`[Roam BG] Processing (${message.trigger}, slide ${message.slideIndex}):`, fullText.slice(0, 60), screenshot ? "+ img" : "");
    const detection = await detectTravel(fullText, screenshot, settings.ANTHROPIC_API_KEY);

    if (!detection.isTravel || detection.destinations.length === 0) {
      console.log("[Roam BG] Not travel content");
      return;
    }

    // Deduplicate by airport code (same airport = same destination)
    const seen = new Set<string>();
    const hits = detection.destinations.filter((h) => {
      const key = h.airportCode.toUpperCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    console.log(`[Roam BG] Detected ${hits.length} destination(s):`, hits.map((h) => h.destination).join(", "));

    // Add all to feed immediately (no flight data yet)
    for (const hit of hits) {
      await addDetection(hit, null, message.pageUrl);
    }

    // Mark all as loading
    await setLoading(hits.map((h) => h.destination));

    // Fire all flight searches — global semaphore limits to 5 concurrent
    await Promise.all(
      hits.map((hit) => processDestination(hit, message.pageUrl, settings))
    );
  } catch (err) {
    console.error("[Roam BG] Error:", err);
    await chrome.storage.local.set({ loadingDestinations: [] });
  }
}

// --- Message listener ---

chrome.runtime.onMessage.addListener(
  (message: ContentPayload, sender, _sendResponse) => {
    if (message.type !== "CONTENT_DETECTED") return;

    const key = slideKey(message.postId, message.slideIndex);

    // Skip if this exact post+slide is already processed or in-flight
    if (processedSlides.has(key)) {
      return;
    }
    processedSlides.add(key);

    console.log(`[Roam BG] Firing (${message.trigger}, ${key}):`, message.description?.slice(0, 50));

    // Fire immediately — runs in parallel with any other in-flight requests
    processRequest(message, sender.tab?.windowId);
    return true;
  }
);
