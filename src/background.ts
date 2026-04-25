import {
  ContentPayload,
  DetectedEntry,
  DestinationHit,
  DetectionResult,
  EngagementEvent,
  FlightResult,
  InterestScore,
  StoredSettings,
} from "./types.js";
import { computeScores } from "./scorer.js";

const GEMINI_MODEL = "gemma-3-27b-it";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const DETECTION_PROMPT = `You are a JSON API. Output ONLY a JSON object, nothing else.

Task: identify travel destinations in this social media post. Read any place names from the image text overlay.

Example output: {"isTravel":true,"destinations":[{"destination":"Paris","country":"France","countryCode":"FR","airportCode":"CDG","vibes":["Romantic"]}]}
No travel: {"isTravel":false,"destinations":[]}

Post caption: `;

// --- Settings ---

async function getSettings(): Promise<StoredSettings> {
  return (await chrome.storage.sync.get([
    "GEMINI_API_KEY",
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

// --- Detection API rate limiter (max 2 concurrent calls) ---

const MAX_CONCURRENT_DETECTIONS = 5;
let activeDetections = 0;
const detectionQueue: (() => void)[] = [];

function acquireDetectionSlot(): Promise<void> {
  if (activeDetections < MAX_CONCURRENT_DETECTIONS) {
    activeDetections++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    detectionQueue.push(() => { activeDetections++; resolve(); });
  });
}

function releaseDetectionSlot(): void {
  activeDetections--;
  const next = detectionQueue.shift();
  if (next) next();
}

// --- Gemini detection ---

async function detectTravel(
  text: string,
  screenshot: string | null,
  apiKey: string
): Promise<DetectionResult> {
  const parts: any[] = [];

  parts.push({
    text: `${DETECTION_PROMPT}${text}`,
  });

  if (screenshot) {
    parts.push({
      inlineData: { mimeType: "image/jpeg", data: screenshot },
    });
  }

  const url = `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        maxOutputTokens: 1024,
        temperature: 0.0,
      },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API error: ${response.status} ${err}`);
  }

  const data = await response.json();
  let responseText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  if (!responseText) {
    console.warn("[Roam BG] Empty Gemma response. Full API data:", JSON.stringify(data).slice(0, 500));
    return { isTravel: false, destinations: [] };
  }
  console.log("[Roam BG] Raw Gemma response:", responseText.slice(0, 400));

  // Gemma often "thinks" before outputting JSON. Extract the JSON object from anywhere in the response.
  function extractJson(text: string): DetectionResult | null {
    // Try to find a JSON block in markdown fences
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) text = fenceMatch[1];

    // Find the first { and match to its closing }
    const start = text.indexOf("{");
    if (start === -1) return null;

    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1)) as DetectionResult;
          } catch {
            return null;
          }
        }
      }
    }

    // Truncated — try to repair by closing open structures
    const partial = text.slice(start);
    const lastComplete = partial.lastIndexOf("},");
    if (lastComplete > 0) {
      try {
        return JSON.parse(partial.slice(0, lastComplete + 1) + "]}") as DetectionResult;
      } catch {
        // Give up
      }
    }
    return null;
  }

  const result = extractJson(responseText);
  if (result) return result;

  console.warn("[Roam BG] Could not extract JSON from Gemma response");
  return { isTravel: false, destinations: [] };
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

async function addLoading(destinations: string[]): Promise<void> {
  const { loadingDestinations = [] } = await chrome.storage.local.get("loadingDestinations");
  const existing = new Set((loadingDestinations as string[]).map((d) => d.toLowerCase()));
  const merged = [...loadingDestinations as string[]];
  for (const d of destinations) {
    if (!existing.has(d.toLowerCase())) {
      merged.push(d);
      existing.add(d.toLowerCase());
    }
  }
  await chrome.storage.local.set({ loadingDestinations: merged });
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

    if (!flight) {
      // No valid flight (bad IATA, no results) — remove from feed
      const { detections = [] } = await chrome.storage.local.get("detections") as { detections: DetectedEntry[] };
      const filtered = detections.filter(
        (d) => d.destination.toLowerCase() !== hit.destination.toLowerCase()
      );
      await chrome.storage.local.set({ detections: filtered });
      console.log(`[Roam BG] Removed ${hit.destination} from feed (no valid flights)`);
    } else {
      await addDetection(hit, flight, sourceUrl);
    }
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
    if (!settings.GEMINI_API_KEY) {
      console.warn("Roam: No Gemini API key set.");
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

    // Without a screenshot, different slides of the same post have identical input — skip
    if (!screenshot && message.slideIndex > 0) {
      console.log(`[Roam BG] Skipping slide ${message.slideIndex} (no screenshot, same text as slide 0)`);
      return;
    }

    console.log(`[Roam BG] Processing (${message.trigger}, slide ${message.slideIndex}):`, fullText.slice(0, 60), screenshot ? "+ img" : "");

    await acquireDetectionSlot();
    let detection: DetectionResult;
    try {
      detection = await detectTravel(fullText, screenshot, settings.GEMINI_API_KEY);
    } finally {
      releaseDetectionSlot();
    }

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
    // If more than 5 destinations from a single slide, it's likely a list/compilation post — skip
    if (hits.length > 5) {
      console.log(`[Roam BG] Skipping — too many destinations (${hits.length}), likely a list post`);
      return;
    }
    console.log(`[Roam BG] Detected ${hits.length} destination(s):`, hits.map((h) => h.destination).join(", "));

    // Register post+slide → destination mapping for engagement tracking
    registerPostDestinations(message.postId, message.slideIndex, hits);

    // Add all to feed immediately (no flight data yet)
    for (const hit of hits) {
      await addDetection(hit, null, message.pageUrl);
    }

    // Mark all as loading
    await addLoading(hits.map((h) => h.destination));

    // Fire all flight searches — global semaphore limits to 5 concurrent
    await Promise.all(
      hits.map((hit) => processDestination(hit, message.pageUrl, settings))
    );
  } catch (err) {
    console.error("[Roam BG] Error:", err);
    await chrome.storage.local.set({ loadingDestinations: [] });
  }
}

// --- V3: Post-to-destination mapping for engagement events ---

// Maps "postId:slideIndex" → { destination, countryCode, country } so engagement events can be linked
const postSlideMap = new Map<string, { destination: string; countryCode: string; country: string }>();

function postSlideKey(postId: string, slideIndex: number): string {
  return `${postId}:${slideIndex}`;
}

// Orphan engagement events that arrived before Claude classified the post+slide
interface OrphanEvent {
  eventType: string;
  duration?: number;
  postId: string;
  slideIndex: number;
  platform: "instagram" | "tiktok";
  timestamp: number;
}
const orphanEvents: OrphanEvent[] = [];

function registerPostDestinations(postId: string, slideIndex: number, hits: DestinationHit[]): void {
  // Map each hit to this postId:slideIndex — first hit is primary for engagement
  // Also register all hits so multiple destinations from one slide get mapped
  for (let i = 0; i < hits.length; i++) {
    const key = i === 0
      ? postSlideKey(postId, slideIndex)
      : postSlideKey(postId, slideIndex) + `:${i}`;
    if (!postSlideMap.has(postSlideKey(postId, slideIndex))) {
      postSlideMap.set(postSlideKey(postId, slideIndex), {
        destination: hits[0].destination,
        countryCode: hits[0].countryCode,
        country: hits[0].country,
      });
    }
  }

  // Drain any orphan events that were waiting for this postId:slideIndex
  const psKey = postSlideKey(postId, slideIndex);
  const pending = orphanEvents.filter((e) => postSlideKey(e.postId, e.slideIndex) === psKey);
  if (pending.length > 0) {
    console.log(`[Roam BG] Draining ${pending.length} orphan event(s) for ${hits[0].destination}`);
    for (let i = orphanEvents.length - 1; i >= 0; i--) {
      if (postSlideKey(orphanEvents[i].postId, orphanEvents[i].slideIndex) === psKey) {
        orphanEvents.splice(i, 1);
      }
    }
    for (const evt of pending) {
      handleEngagementEvent(evt);
    }
  }
}

// --- V3: Engagement event handler ---

async function handleEngagementEvent(msg: {
  eventType: string;
  duration?: number;
  postId: string;
  slideIndex: number;
  platform: "instagram" | "tiktok";
  timestamp: number;
}): Promise<void> {
  // Look up which destination this post+slide maps to
  const key = postSlideKey(msg.postId, msg.slideIndex);
  const dest = postSlideMap.get(key);
  if (!dest) {
    // Post+slide hasn't been classified as travel yet — queue for later
    orphanEvents.push(msg);
    console.log(`[Roam BG] Queued orphan ${msg.eventType} for ${key}`);
    return;
  }

  const event: EngagementEvent = {
    destination: dest.destination,
    countryCode: dest.countryCode,
    eventType: msg.eventType as EngagementEvent["eventType"],
    duration: msg.duration,
    postId: msg.postId,
    platform: msg.platform,
    timestamp: msg.timestamp,
  };

  // Append to engagement log
  const { engagementLog = [] } = await chrome.storage.local.get("engagementLog") as { engagementLog: EngagementEvent[] };
  engagementLog.push(event);

  // Trim old events (keep last 30 days)
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const trimmed = engagementLog.filter((e) => e.timestamp > cutoff);

  // Recompute scores
  const { interestScores = [] } = await chrome.storage.local.get("interestScores") as { interestScores: InterestScore[] };

  // Enrich scores with country/flight data from detections
  const { detections = [] } = await chrome.storage.local.get("detections") as { detections: DetectedEntry[] };
  const scores = computeScores(trimmed, interestScores);

  // Fill in country and flight data from detections (always use latest)
  for (const score of scores) {
    const match = detections.find((d) =>
      d.destination.toLowerCase() === score.destination.toLowerCase() ||
      (d.airportCode && d.airportCode === score.airportCode)
    );
    if (match) {
      if (!score.country) score.country = match.country;
      if (!score.airportCode) score.airportCode = match.airportCode;
      if (match.flight) score.flight = match.flight;
    }
  }

  await chrome.storage.local.set({
    engagementLog: trimmed,
    interestScores: scores,
  });

  console.log(`[Roam BG] Engagement: ${msg.eventType} for ${dest.destination} (score: ${scores.find(s => s.destination === dest.destination)?.score ?? 0})`);
}

// --- Message listener ---

chrome.runtime.onMessage.addListener(
  (message: any, sender, _sendResponse) => {
    if (message.type === "CONTENT_DETECTED") {
      const key = slideKey(message.postId, message.slideIndex);

      // Skip if this exact post+slide is already processed or in-flight
      if (processedSlides.has(key)) {
        return;
      }
      processedSlides.add(key);

      console.log(`[Roam BG] Firing (${message.trigger}, ${key}):`, message.description?.slice(0, 50));

      // Fire immediately — runs in parallel with any other in-flight requests
      processRequest(message as ContentPayload, sender.tab?.windowId);
      return true;
    }

    if (message.type === "ENGAGEMENT_EVENT") {
      handleEngagementEvent(message);
      return true;
    }
  }
);
