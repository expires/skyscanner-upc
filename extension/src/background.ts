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
import { CONFIG } from "./config.js";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const DETECTION_PROMPT = `You are a strict JSON API for a travel inspiration app. Output ONLY a JSON object, nothing else.

Task: Identify genuine travel destinations in this social media post. The screenshot is your primary source.
CRITICAL RULES:
1. ONLY return isTravel: true if the MAIN FOCUS of the post is tourism, exploring, or showcasing a specific location's beauty/culture.
2. REJECT (isTravel: false) posts about: memes, gaming (e.g. Xbox, PlayStation), tech, news, comedy, music videos, or general internet culture.
3. REJECT posts where a location is merely in the background (e.g. a person talking to the camera in London, but the topic is gaming or comedy).
4. If it is a genuine travel post, list the destinations.

Example output: {"isTravel":true,"destinations":[{"destination":"Paris","country":"France","countryCode":"FR","airportCode":"CDG","vibes":["Romantic"]}]}
No travel / Rejected: {"isTravel":false,"destinations":[]}

Post text (supplementary): `;

// --- Settings ---

async function getSettings(): Promise<StoredSettings> {
  return (await chrome.storage.sync.get([
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

// --- Backend Proxy ---

async function getDeviceId(): Promise<string> {
  const stored = await chrome.storage.local.get('roam:deviceId');
  if (stored['roam:deviceId']) return stored['roam:deviceId'];
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ 'roam:deviceId': id });
  return id;
}

// --- Gemini detection via Backend ---

async function detectTravel(
  text: string,
  screenshot: string | null,
  postId: string,
  platform: 'instagram' | 'tiktok'
): Promise<DetectionResult> {
  const deviceId = await getDeviceId();
  
  const response = await fetch(`${CONFIG.BACKEND_URL}/detect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-device-id": deviceId
    },
    body: JSON.stringify({
      text,
      screenshot,
      postId,
      platform
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Backend detection error: ${response.status} ${err}`);
  }

  return response.json();
}

// --- Skyscanner ---

const SKYSCANNER_BASE =
  "https://partners.api.skyscanner.net/apiservices/v3/flights/live/search";

/**
 * Dynamic poll budget based on config.
 * More genuine interest → more polling attempts → higher chance of a complete result.
 */
function maxPollsForDwell(totalDwellMs: number): number {
  const extraBuckets = Math.floor(totalDwellMs / CONFIG.POLLING.DWELL_MS_PER_EXTRA_POLL);
  return Math.min(CONFIG.POLLING.BASE_MAX_POLLS + extraBuckets, CONFIG.POLLING.CEILING_MAX_POLLS);
}

// Main hub airport per country — used when a single post mentions multiple places in the same country.
const COUNTRY_HUB: Record<string, { airportCode: string; city: string }> = {
  AD: { airportCode: 'BCN', city: 'Barcelona (for Andorra)' },
  AE: { airportCode: 'DXB', city: 'Dubai, UAE' },
  AR: { airportCode: 'EZE', city: 'Buenos Aires, Argentina' },
  AT: { airportCode: 'VIE', city: 'Vienna, Austria' },
  AU: { airportCode: 'SYD', city: 'Sydney, Australia' },
  BA: { airportCode: 'SJJ', city: 'Sarajevo, Bosnia' },
  BE: { airportCode: 'BRU', city: 'Brussels, Belgium' },
  BG: { airportCode: 'SOF', city: 'Sofia, Bulgaria' },
  BR: { airportCode: 'GRU', city: 'São Paulo, Brazil' },
  CA: { airportCode: 'YYZ', city: 'Toronto, Canada' },
  CH: { airportCode: 'ZRH', city: 'Zurich, Switzerland' },
  CL: { airportCode: 'SCL', city: 'Santiago, Chile' },
  CN: { airportCode: 'PEK', city: 'Beijing, China' },
  CO: { airportCode: 'BOG', city: 'Bogotá, Colombia' },
  CR: { airportCode: 'SJO', city: 'San José, Costa Rica' },
  CZ: { airportCode: 'PRG', city: 'Prague, Czech Republic' },
  DE: { airportCode: 'FRA', city: 'Frankfurt, Germany' },
  DK: { airportCode: 'CPH', city: 'Copenhagen, Denmark' },
  EG: { airportCode: 'CAI', city: 'Cairo, Egypt' },
  ES: { airportCode: 'MAD', city: 'Madrid, Spain' },
  FI: { airportCode: 'HEL', city: 'Helsinki, Finland' },
  FR: { airportCode: 'CDG', city: 'Paris, France' },
  GB: { airportCode: 'LHR', city: 'London, United Kingdom' },
  GR: { airportCode: 'ATH', city: 'Athens, Greece' },
  HR: { airportCode: 'ZAG', city: 'Zagreb, Croatia' },
  HU: { airportCode: 'BUD', city: 'Budapest, Hungary' },
  ID: { airportCode: 'CGK', city: 'Jakarta, Indonesia' },
  IE: { airportCode: 'DUB', city: 'Dublin, Ireland' },
  IL: { airportCode: 'TLV', city: 'Tel Aviv, Israel' },
  IN: { airportCode: 'DEL', city: 'New Delhi, India' },
  IS: { airportCode: 'KEF', city: 'Reykjavík, Iceland' },
  IT: { airportCode: 'FCO', city: 'Rome, Italy' },
  JP: { airportCode: 'NRT', city: 'Tokyo, Japan' },
  KR: { airportCode: 'ICN', city: 'Seoul, South Korea' },
  MA: { airportCode: 'CMN', city: 'Casablanca, Morocco' },
  MX: { airportCode: 'MEX', city: 'Mexico City, Mexico' },
  MY: { airportCode: 'KUL', city: 'Kuala Lumpur, Malaysia' },
  NL: { airportCode: 'AMS', city: 'Amsterdam, Netherlands' },
  NO: { airportCode: 'OSL', city: 'Oslo, Norway' },
  NZ: { airportCode: 'AKL', city: 'Auckland, New Zealand' },
  PE: { airportCode: 'LIM', city: 'Lima, Peru' },
  PH: { airportCode: 'MNL', city: 'Manila, Philippines' },
  PL: { airportCode: 'WAW', city: 'Warsaw, Poland' },
  PT: { airportCode: 'LIS', city: 'Lisbon, Portugal' },
  RO: { airportCode: 'OTP', city: 'Bucharest, Romania' },
  RS: { airportCode: 'BEG', city: 'Belgrade, Serbia' },
  SE: { airportCode: 'ARN', city: 'Stockholm, Sweden' },
  SG: { airportCode: 'SIN', city: 'Singapore' },
  SK: { airportCode: 'BTS', city: 'Bratislava, Slovakia' },
  TH: { airportCode: 'BKK', city: 'Bangkok, Thailand' },
  TR: { airportCode: 'IST', city: 'Istanbul, Turkey' },
  TW: { airportCode: 'TPE', city: 'Taipei, Taiwan' },
  US: { airportCode: 'JFK', city: 'New York, USA' },
  VN: { airportCode: 'SGN', city: 'Ho Chi Minh City, Vietnam' },
  ZA: { airportCode: 'JNB', city: 'Johannesburg, South Africa' },
};

/**
 * If a single post mentions 2+ places in the same country, collapse them into
 * one entry using the country's main hub airport. Vibes are merged from all hits.
 */
function consolidateByCountry(hits: DestinationHit[]): DestinationHit[] {
  // Countries that are too large to consolidate (cities > 2 hours apart)
  const NO_CONSOLIDATION = new Set(['US', 'CA', 'AU', 'BR', 'RU', 'CN', 'IN', 'MX', 'AR']);
  
  const byCountry = new Map<string, DestinationHit[]>();
  const result: DestinationHit[] = [];

  for (const hit of hits) {
    const code = hit.countryCode.toUpperCase();
    if (NO_CONSOLIDATION.has(code)) {
      result.push(hit); // Do not consolidate, keep distinct
    } else {
      if (!byCountry.has(code)) byCountry.set(code, []);
      byCountry.get(code)!.push(hit);
    }
  }


  for (const [countryCode, countryHits] of byCountry) {
    const hub = COUNTRY_HUB[countryCode];
    const mergedVibes = [...new Set(countryHits.flatMap((h) => h.vibes))].slice(0, 3);
    const individualNames = countryHits.map((h) => h.destination);

    if (countryHits.length === 1) {
      const hit = countryHits[0];
      // If single hit is missing airportCode, try to fill from hub
      if (!hit.airportCode && hub) {
        result.push({
          ...hit,
          airportCode: hub.airportCode,
          vibes: mergedVibes,
        });
        console.log(`[Roam BG] Single hit ${hit.destination} missing IATA, using hub ${hub.airportCode}`);
      } else {
        result.push({ ...hit, vibes: mergedVibes });
      }
      continue;
    }

    // Multiple destinations in one country — consolidate to hub airport
    const consolidated: DestinationHit & { mergedLocations?: string[] } = hub
      ? {
          destination: hub.city,
          country: countryHits[0].country,
          countryCode,
          airportCode: hub.airportCode,
          vibes: mergedVibes,
          mergedLocations: individualNames,
        }
      : { ...countryHits[0], vibes: mergedVibes, mergedLocations: individualNames };
    
    console.log(
      `[Roam BG] Consolidated ${countryHits.length} ${countryCode} destinations (${countryHits.map((h) => h.destination).join(", ")}) → ${consolidated.airportCode}`
    );
    result.push(consolidated);
  }
  return result;
}

async function searchFlights(
  destAirport: string,
  homeAirport: string,
  currency: string = "EUR",
  maxPolls: number = CONFIG.POLLING.BASE_MAX_POLLS
): Promise<FlightResult | null> {
  try {
    const deviceId = await getDeviceId();
    const response = await fetch(`${CONFIG.BACKEND_URL}/flights`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-device-id": deviceId
      },
      body: JSON.stringify({
        iataCode: destAirport,
        homeAirport,
        currency,
        maxPolls
      }),
    });

    if (!response.ok) {
      console.warn("[Roam BG] Backend flights error", response.status, await response.text());
      return null;
    }

    const data = await response.json();
    if (data.error) return null;
    return data;
  } catch (e) {
    console.warn("[Roam BG] Backend flights fetch failed:", e);
    return null;
  }
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
    // Carry mergedLocations if the hit was already consolidated (per-post consolidation)
    mergedLocations: (hit as any).mergedLocations ?? existing?.mergedLocations,
  };

  if (existingIdx >= 0) detections.splice(existingIdx, 1);
  detections.unshift(entry);
  if (detections.length > MAX_DETECTIONS) detections.length = MAX_DETECTIONS;

  // Cross-post consolidation: if the feed now has 2+ entries for the same country,
  // merge them all into one hub-airport entry (cheapest flight wins, vibes merged).
  const consolidated = consolidateFeed(detections);
  await chrome.storage.local.set({ detections: consolidated });
}

/**
 * Scans the full detections feed. Any country with 2+ entries is collapsed into
 * a single hub-airport entry. The position of the first (most-recent) occurrence
 * is preserved. The cheapest flight across all entries is kept.
 */
function consolidateFeed(detections: DetectedEntry[]): DetectedEntry[] {
  // Countries that are too large to consolidate (cities > 2 hours apart)
  const NO_CONSOLIDATION = new Set(['US', 'CA', 'AU', 'BR', 'RU', 'CN', 'IN', 'MX', 'AR']);

  // Group indices by countryCode
  const byCountry = new Map<string, number[]>();
  for (let i = 0; i < detections.length; i++) {
    const code = detections[i].countryCode?.toUpperCase();
    if (!code || NO_CONSOLIDATION.has(code)) continue; // Skip large countries
    if (!byCountry.has(code)) byCountry.set(code, []);
    byCountry.get(code)!.push(i);
  }

  // Collect indices to remove (all but the first occurrence per country group)
  const toRemove = new Set<number>();

  for (const [countryCode, indices] of byCountry) {
    if (indices.length < 2) continue;

    const hub = COUNTRY_HUB[countryCode];
    const group = indices.map((i) => detections[i]);

    // Pick cheapest flight across the group
    const cheapest = group
      .map((d) => d.flight)
      .filter(Boolean)
      .sort((a, b) => (a!.price ?? Infinity) - (b!.price ?? Infinity))[0] ?? null;

    const mergedVibes = [...new Set(group.flatMap((d) => d.vibes))].slice(0, 3);

    // Overwrite the first (most-recent) entry with the consolidated version
    const primary = detections[indices[0]];
    // Collect all individual location names (expand any already-merged entries)
    const allNames = [...new Set(
      group.flatMap((d) => d.mergedLocations?.length ? d.mergedLocations : [d.destination])
    )];
    detections[indices[0]] = {
      ...primary,
      destination: hub?.city ?? primary.destination,
      airportCode: hub?.airportCode ?? primary.airportCode,
      vibes: mergedVibes,
      flight: cheapest,
      mergedLocations: allNames,
    };

    // Mark the rest for removal
    for (let i = 1; i < indices.length; i++) {
      toRemove.add(indices[i]);
    }

    console.log(
      `[Roam BG] Feed consolidated ${group.length} ${countryCode} entries → ${hub?.airportCode ?? primary.airportCode}, cheapest: ${cheapest?.price ?? "none"}`
    );
  }

  return detections.filter((_, i) => !toRemove.has(i));
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

  if (!airportCode) {
    console.warn(`[Roam BG] Skipping ${hit.destination} — no airport code available`);
    const { detections = [] } = await chrome.storage.local.get("detections") as { detections: DetectedEntry[] };
    const filtered = detections.filter(
      (d) => d.destination.toLowerCase() !== hit.destination.toLowerCase()
    );
    await chrome.storage.local.set({ detections: filtered });
    await removeLoading(hit.destination);
    return;
  }

  // Check cache first — no slot needed
  if (flightCache.has(airportCode)) {
    const cachedFlight = flightCache.get(airportCode) ?? null;
    await addDetection(hit, cachedFlight, sourceUrl);
    await removeLoading(hit.destination);
    return;
  }

  // Compute dwell-based poll budget from the engagement log
  const { engagementLog = [] } = await chrome.storage.local.get("engagementLog") as { engagementLog: EngagementEvent[] };
  const totalDwellMs = engagementLog
    .filter(
      (e) =>
        e.destination.toLowerCase() === hit.destination.toLowerCase() &&
        e.eventType === "dwell" &&
        typeof e.duration === "number"
    )
    .reduce((sum, e) => sum + (e.duration ?? 0), 0);
  const maxPolls = maxPollsForDwell(totalDwellMs);
  console.log(`[Roam BG] ${hit.destination}: ${Math.round(totalDwellMs / 1000)}s dwell → ${maxPolls} max polls`);

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
      settings.CURRENCY || "EUR",
      maxPolls
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

    // Capture screenshot
    let screenshot: string | null = null;
    if (windowId) {
      screenshot = await captureTab(windowId);
    }

    const fullText = [message.description, ...message.hashtags, message.locationTag ?? ""]
      .filter(Boolean)
      .join(" ");

    // If there's no screenshot and no text at all, nothing to send
    if (!screenshot && !fullText.trim()) {
      console.log(`[Roam BG] Skipping — no screenshot and no text for slide ${message.slideIndex}`);
      return;
    }

    console.log(`[Roam BG] Processing (${message.trigger}, slide ${message.slideIndex}):`, fullText.slice(0, 60) || "(no caption)", screenshot ? "+ screenshot" : "text-only");

    await acquireDetectionSlot();
    let detection: DetectionResult;
    try {
      const platform = message.trigger.includes("tiktok") ? "tiktok" : "instagram";
      detection = await detectTravel(fullText, screenshot, message.postId, platform);
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
      // Handle cases where Gemma might not provide an airportCode
      const key = (h.airportCode || h.destination).toUpperCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // If more than configured destinations from a single slide, it's likely a list/compilation post — skip
    if (hits.length > CONFIG.LIMITS.MAX_DESTINATIONS_PER_SLIDE) {
      console.log(`[Roam BG] Skipping — too many destinations (${hits.length}), likely a list post`);
      return;
    }

    // Consolidate multiple places in the same country into one hub-airport entry
    const consolidatedHits = consolidateByCountry(hits);
    console.log(`[Roam BG] Detected ${consolidatedHits.length} destination(s):`, consolidatedHits.map((h) => h.destination).join(", "));

    // Register post+slide → destination mapping for engagement tracking
    registerPostDestinations(message.postId, message.slideIndex, consolidatedHits);

    // Add all to feed immediately (no flight data yet)
    for (const hit of consolidatedHits) {
      await addDetection(hit, null, message.pageUrl);
    }

    // Mark all as loading
    await addLoading(consolidatedHits.map((h) => h.destination));

    // Fire all flight searches — global semaphore limits to 5 concurrent
    await Promise.all(
      consolidatedHits.map((hit) => processDestination(hit, message.pageUrl, settings))
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

  // Normalize engagement log: if a destination matches a country name or code, 
  // map it to the current hub name to preserve scoring across name changes.
  const normalizedLog = trimmed.map(e => {
    const hub = COUNTRY_HUB[e.countryCode.toUpperCase()];
    if (hub && (e.destination === e.countryCode || e.destination.toLowerCase() === hub.city.toLowerCase().split(',')[1]?.trim().toLowerCase())) {
      return { ...e, destination: hub.city };
    }
    return e;
  });

  // Enrich scores with country/flight data from detections
  const { detections = [] } = await chrome.storage.local.get("detections") as { detections: DetectedEntry[] };
  const scores = computeScores(normalizedLog, interestScores);

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
      if (match.mergedLocations) score.mergedLocations = match.mergedLocations;
    }
  }

  await chrome.storage.local.set({
    engagementLog: trimmed,
    interestScores: scores,
  });

  // Sync to backend (fire and forget)
  syncEngagementToBackend(event, scores).catch((err) =>
    console.warn("[Roam BG] Failed to sync engagement to backend:", err)
  );

  console.log(`[Roam BG] Engagement: ${msg.eventType} for ${dest.destination} (score: ${scores.find(s => s.destination === dest.destination)?.score ?? 0})`);
}

async function syncEngagementToBackend(event: EngagementEvent, scores: InterestScore[]): Promise<void> {
  const deviceId = await getDeviceId();
  
  // 1. Sync event
  await fetch(`${CONFIG.BACKEND_URL}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-device-id": deviceId },
    body: JSON.stringify({ events: [event] })
  });

  // 2. Sync updated scores
  await fetch(`${CONFIG.BACKEND_URL}/scores`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-device-id": deviceId },
    body: JSON.stringify({ scores })
  });
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
