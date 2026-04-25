export interface DestinationHit {
  destination: string;
  country: string;
  countryCode: string;
  airportCode: string;
  vibes: string[];
}

export interface DetectionResult {
  isTravel: boolean;
  destinations: DestinationHit[];
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
  postId: string;
  slideIndex: number;
  trigger: "text_change" | "slide_change" | "video_tick";
}

// --- V3: Engagement & Interest Scoring ---

export type EngagementEventType =
  | 'dwell'
  | 'rewatch'
  | 'sound_on'
  | 'profile_click'
  | 'hashtag_click'
  | 'scroll_back'
  | 'save_click'
  | 'share_click'
  | 'comment_open'
  | 'caption_expand'
  | 'video_pause'
  | 'like';

export interface EngagementEvent {
  destination: string;
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
  airportCode: string | null;
  score: number;            // 0–100 normalised
  rawScore: number;
  breakdown: {
    totalDwell: number;     // ms
    rewatches: number;
    soundOns: number;
    profileClicks: number;
    hashtagClicks: number;
    saveClicks: number;
    shareClicks: number;
    commentOpens: number;
    captionExpands: number;
    videoPauses: number;
    likes: number;
    postCount: number;
  };
  flight: FlightResult | null;
  lastUpdated: number;
}

// --- Storage & Settings ---

// Stored state in chrome.storage.local
export interface StoredState {
  detections: DetectedEntry[];
  wishlist: WishlistEntry[];
  engagementLog: EngagementEvent[];
  interestScores: InterestScore[];
}

// Settings stored in chrome.storage.sync
export interface StoredSettings {
  GEMINI_API_KEY: string;
  SKYSCANNER_API_KEY: string;
  HOME_AIRPORT: string;
  CURRENCY: string;
}
