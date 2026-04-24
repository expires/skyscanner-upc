export interface DetectionResult {
  isTravel: boolean;
  destination: string | null;
  country: string | null;
  countryCode: string | null;
  airportCode: string | null;
  vibes: string[];
}

export interface FlightResult {
  price: number;
  currency: string;
  airline: string;
  durationMinutes: number;
  deeplink: string;
}

// A detected destination in the feed
export interface DetectedEntry {
  id: string;
  destination: string;
  country: string;
  countryCode: string;
  airportCode: string | null;
  vibes: string[];
  flight: FlightResult | null;
  sourceUrl: string;
  detectedAt: number;
}

export interface WishlistEntry {
  id: string;
  destination: string;
  country: string;
  countryCode: string;
  vibes: string[];
  flight: FlightResult | null;
  sourceUrl: string;
  savedAt: number;
}

// Message types between content script and background
export interface ContentPayload {
  type: "CONTENT_DETECTED";
  description: string;
  hashtags: string[];
  locationTag: string | null;
  pageUrl: string;
  trigger: "text_change" | "slide_change" | "video_tick";
}

// Stored state in chrome.storage.local
export interface StoredState {
  detections: DetectedEntry[];
  wishlist: WishlistEntry[];
}

// Settings stored in chrome.storage.sync
export interface StoredSettings {
  ANTHROPIC_API_KEY: string;
  SKYSCANNER_API_KEY: string;
  HOME_AIRPORT: string;
}
