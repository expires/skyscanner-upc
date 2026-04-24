import {
  ContentPayload,
  DetectedEntry,
  DetectionResult,
  FlightResult,
  StoredSettings,
  StoredState,
} from "./types.js";

const CLAUDE_MODEL = "claude-haiku-4-5-20251001";
const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";

const CLAUDE_PROMPT = `You are a travel content detector analyzing social media content. You will be given post text and a screenshot of the current page. Use BOTH the text and the visual content (images, video frames, slideshows) to determine if this is travel content.

Respond ONLY with valid JSON, no markdown, no explanation:
{
  "isTravel": boolean,
  "destination": string | null,
  "country": string | null,
  "countryCode": string | null,
  "airportCode": string | null,
  "vibes": string[]
}

Rules:
- Use the screenshot to identify destinations even if the caption is vague (e.g. generic captions like "places to visit" with visible landmarks)
- vibes: max 3 short tags, e.g. "Beach", "Budget-friendly", "Temples"
- countryCode: ISO 3166-1 alpha-2 (e.g. "TH", "JP", "ES")
- airportCode: nearest major airport IATA code (e.g. "CNX" for Chiang Mai, "BCN" for Barcelona, "BKK" for Bangkok)
- If the post mentions multiple destinations, pick the FIRST or most prominent one
- destination must be a specific city or place name, never null if isTravel is true
- airportCode must be set whenever destination is set
- If not travel content, set isTravel to false and all other fields to null/empty`;

async function getSettings(): Promise<StoredSettings> {
  const result = await chrome.storage.sync.get([
    "ANTHROPIC_API_KEY",
    "SKYSCANNER_API_KEY",
    "HOME_AIRPORT",
  ]);
  return result as StoredSettings;
}

async function captureTab(windowId: number): Promise<string | null> {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(
      windowId,
      { format: "jpeg", quality: 60 }
    );
    // dataUrl is "data:image/jpeg;base64,..." — extract the base64 part
    return dataUrl.split(",")[1] ?? null;
  } catch (e) {
    console.warn("[Wander BG] Tab capture failed:", e);
    return null;
  }
}

async function detectTravel(
  text: string,
  screenshot: string | null,
  apiKey: string
): Promise<DetectionResult> {
  // Build message content — text + optional image
  const content: any[] = [];

  if (screenshot) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: screenshot,
      },
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
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content,
        },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error: ${response.status} ${err}`);
  }

  const data = await response.json();
  let responseText = data.content?.[0]?.text ?? "{}";

  // Strip markdown code fences if Claude wraps the JSON
  responseText = responseText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  return JSON.parse(responseText) as DetectionResult;
}

// Skyscanner flight search with polling
const SKYSCANNER_BASE = "https://partners.api.skyscanner.net/apiservices/v3/flights/live/search";
const MAX_POLLS = 5;
const POLL_DELAY_MS = 2000;

function buildSkyscannerQuery(homeAirport: string, destAirport: string) {
  return {
    query: {
      market: "ES",
      locale: "en-GB",
      currency: "EUR",
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
  apiKey: string
): Promise<FlightResult | null> {
  if (!apiKey) {
    return null;
  }

  try {
    // Step 1: Create search session
    const createRes = await fetch(`${SKYSCANNER_BASE}/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify(buildSkyscannerQuery(homeAirport, destAirport)),
    });

    if (!createRes.ok) {
      const errBody = await createRes.text();
      console.warn("[Wander BG] Skyscanner create error", createRes.status, errBody);
      return null;
    }

    let data = await createRes.json();
    console.log("[Wander BG] Skyscanner create status:", data.status);

    // Step 2: Poll if incomplete
    const sessionToken = data.sessionToken;
    let polls = 0;
    while (data.status === "RESULT_STATUS_INCOMPLETE" && polls < MAX_POLLS && sessionToken) {
      await new Promise((r) => setTimeout(r, POLL_DELAY_MS));
      polls++;
      console.log(`[Wander BG] Skyscanner polling (${polls}/${MAX_POLLS})...`);

      const pollRes = await fetch(`${SKYSCANNER_BASE}/poll/${sessionToken}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify(buildSkyscannerQuery(homeAirport, destAirport)),
      });

      if (!pollRes.ok) break;
      data = await pollRes.json();
      console.log("[Wander BG] Skyscanner poll status:", data.status);
    }

    const result = parseSkyscannerResult(data, homeAirport, destAirport);
    if (!result) {
      console.warn("[Wander BG] No flights found for route", homeAirport, "→", destAirport);
    }
    return result;
  } catch (e) {
    console.warn("[Wander BG] Skyscanner fetch failed:", e);
    return null;
  }
}

function parseSkyscannerResult(data: any, origin: string, dest: string): FlightResult | null {
  const itineraries = data?.content?.results?.itineraries;
  if (!itineraries) return null;

  const entries = Object.values(itineraries) as any[];
  if (entries.length === 0) return null;

  // Sort by cheapest price
  entries.sort(
    (a: any, b: any) =>
      parseFloat(a.pricingOptions?.[0]?.price?.amount ?? "Infinity") -
      parseFloat(b.pricingOptions?.[0]?.price?.amount ?? "Infinity")
  );

  const cheapest = entries[0];
  const pricing = cheapest.pricingOptions?.[0];
  if (!pricing) return null;

  const priceAmount = parseFloat(pricing.price?.amount ?? "0");
  const price = priceAmount > 1000 ? Math.round(priceAmount / 1000) : Math.round(priceAmount);

  // Resolve carrier name: legs are IDs referencing data.content.results.legs
  const legs = data?.content?.results?.legs;
  const carriers = data?.content?.results?.carriers;
  let airlineName = "Unknown";
  const legId = cheapest.legIds?.[0];
  if (legId && legs && carriers) {
    const leg = legs[legId];
    const carrierId = leg?.operatingCarrierIds?.[0] ?? leg?.marketingCarrierIds?.[0];
    if (carrierId) {
      airlineName = carriers[carrierId]?.name ?? "Unknown";
    }
  }

  // Build a working Skyscanner deeplink
  const date = getNextWeekendDate();
  const dateStr = `${date.year}${String(date.month).padStart(2, "0")}${String(date.day).padStart(2, "0")}`;
  const fallbackLink = `https://www.skyscanner.net/transport/flights/${origin.toLowerCase()}/${dest.toLowerCase()}/${dateStr}/`;
  const deeplink = pricing.items?.[0]?.deepLink || fallbackLink;

  return {
    price,
    currency: "EUR",
    airline: airlineName,
    deeplink,
  };
}

function getNextWeekendDate(): { year: number; month: number; day: number } {
  const now = new Date();
  const daysUntilFriday = (5 - now.getDay() + 7) % 7 || 7;
  const friday = new Date(now);
  friday.setDate(now.getDate() + daysUntilFriday);
  return {
    year: friday.getFullYear(),
    month: friday.getMonth() + 1,
    day: friday.getDate(),
  };
}

const MAX_DETECTIONS = 50;

async function addDetection(
  detection: DetectionResult,
  flight: FlightResult | null,
  sourceUrl: string
): Promise<void> {
  if (!detection.isTravel || !detection.destination || !detection.country || !detection.countryCode) return;

  const { detections = [] } = (await chrome.storage.local.get("detections")) as { detections: DetectedEntry[] };

  // Update existing entry if same destination, otherwise prepend
  const existingIdx = detections.findIndex(
    (d) => d.destination.toLowerCase() === detection.destination!.toLowerCase()
  );

  const entry: DetectedEntry = {
    id: existingIdx >= 0 ? detections[existingIdx].id : crypto.randomUUID(),
    destination: detection.destination,
    country: detection.country,
    countryCode: detection.countryCode,
    airportCode: detection.airportCode,
    vibes: detection.vibes,
    flight: flight ?? (existingIdx >= 0 ? detections[existingIdx].flight : null),
    sourceUrl,
    detectedAt: Date.now(),
  };

  if (existingIdx >= 0) {
    detections.splice(existingIdx, 1);
  }

  // Prepend newest
  detections.unshift(entry);

  // Cap list size
  if (detections.length > MAX_DETECTIONS) {
    detections.length = MAX_DETECTIONS;
  }

  await chrome.storage.local.set({ detections });
}

// --- Processing queue ---
// Ensures only one request is processed at a time.
// New arrivals replace any queued (waiting) request so we always process the freshest content.

interface QueuedRequest {
  message: ContentPayload;
  windowId: number | undefined;
}

let isProcessing = false;
let pendingRequest: QueuedRequest | null = null;
// Track the last result we got from Claude to avoid redundant Skyscanner calls
let lastDetectedDestination = "";

async function processRequest(req: QueuedRequest): Promise<void> {
  const { message, windowId } = req;
  try {
    const settings = await getSettings();
    if (!settings.ANTHROPIC_API_KEY) {
      console.warn("Wander: No Anthropic API key set. Open extension settings.");
      return;
    }

    // Capture fresh screenshot
    let screenshot: string | null = null;
    if (windowId) {
      screenshot = await captureTab(windowId);
      console.log("[Wander BG] Screenshot:", screenshot ? `${Math.round(screenshot.length / 1024)}KB` : "failed");
    }

    const fullText = [
      message.description,
      ...message.hashtags,
      message.locationTag ?? "",
    ]
      .filter(Boolean)
      .join(" ");

    console.log(`[Wander BG] Processing (${message.trigger}):`, fullText.slice(0, 60), screenshot ? "+ img" : "");
    const detection = await detectTravel(fullText, screenshot, settings.ANTHROPIC_API_KEY);
    console.log("[Wander BG] Claude:", detection.isTravel ? `${detection.destination} (${detection.airportCode})` : "not travel");

    if (!detection.isTravel || !detection.destination) {
      lastDetectedDestination = "";
      return;
    }

    // Add detection immediately (no flight yet) so it appears in the feed
    await addDetection(detection, null, message.pageUrl);

    const destAirport = detection.airportCode ?? detection.destination;

    // Only call Skyscanner if destination changed
    if (destAirport !== lastDetectedDestination) {
      lastDetectedDestination = destAirport;

      // Mark as loading
      await chrome.storage.local.set({ loadingDestination: detection.destination });

      const flight = await searchFlights(
        destAirport,
        settings.HOME_AIRPORT || "BCN",
        settings.SKYSCANNER_API_KEY
      );
      console.log("[Wander BG] Flight:", flight ? `${flight.price} ${flight.currency} (${flight.airline})` : "none found");

      // Update entry with flight data
      if (flight) {
        await addDetection(detection, flight, message.pageUrl);
      }

      // Clear loading
      await chrome.storage.local.set({ loadingDestination: null });
    }
  } catch (err) {
    console.error("[Wander BG] Error:", err);
  }
}

async function drainQueue(): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;

  while (pendingRequest) {
    const req = pendingRequest;
    pendingRequest = null; // Clear so new arrivals can replace
    await processRequest(req);
  }

  isProcessing = false;
}

// Listen for messages from content script
chrome.runtime.onMessage.addListener(
  (message: ContentPayload, sender, _sendResponse) => {
    if (message.type !== "CONTENT_DETECTED") return;

    console.log(`[Wander BG] Queued (${message.trigger}):`, message.description?.slice(0, 50));

    // Always replace the pending request with the newest one
    pendingRequest = {
      message,
      windowId: sender.tab?.windowId,
    };

    drainQueue();
    return true;
  }
);
