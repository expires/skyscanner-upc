import { EngagementEvent, InterestScore } from "./types.js";

const WEIGHTS: Record<string, number> = {
  dwell: 0.5,             // base per second — scaled non-linearly below
  rewatch: 25,            // high intent — they came BACK
  sound_on: 12,           // chose to hear it
  profile_click: 30,      // strongest single signal — researching the creator
  hashtag_click: 20,      // exploring the topic
  scroll_back: 18,        // deliberate return
  save_click: 35,         // bookmarked — highest intent discrete action
  share_click: 30,        // sharing with someone = seriously considering
  comment_open: 15,       // reading comments = deep engagement
  caption_expand: 10,     // reading full caption
  video_pause: 8,         // paused to look closer
  like: 20,               // liked the post — clear positive signal
};

// Bonus: seeing the same destination across multiple different posts
const MULTI_POST_BONUS = 10; // per additional unique post beyond the first

const DECAY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Non-linear dwell: first 5s = base, 5-15s = 1.5x, 15-30s = 2x, 30s+ = 3x
function dwellScore(durationMs: number): number {
  const secs = durationMs / 1000;
  if (secs <= 5) return secs * WEIGHTS.dwell;
  if (secs <= 15) return 5 * WEIGHTS.dwell + (secs - 5) * WEIGHTS.dwell * 1.5;
  if (secs <= 30) return 5 * WEIGHTS.dwell + 10 * WEIGHTS.dwell * 1.5 + (secs - 15) * WEIGHTS.dwell * 2;
  return 5 * WEIGHTS.dwell + 10 * WEIGHTS.dwell * 1.5 + 15 * WEIGHTS.dwell * 2 + (secs - 30) * WEIGHTS.dwell * 3;
}

export function calculateRawScore(events: EngagementEvent[]): number {
  const now = Date.now();

  // Count unique posts for multi-post bonus
  const uniquePosts = new Set(events.map((e) => e.postId));
  const multiPostBonus = Math.max(0, uniquePosts.size - 1) * MULTI_POST_BONUS;

  const eventScore = events.reduce((total, event) => {
    const age = now - event.timestamp;
    const decayFactor = Math.pow(0.5, age / DECAY_HALF_LIFE_MS);

    if (event.eventType === "dwell" && event.duration) {
      return total + dwellScore(event.duration) * decayFactor;
    }
    return total + (WEIGHTS[event.eventType] ?? 0) * decayFactor;
  }, 0);

  return eventScore + multiPostBonus;
}

export function buildBreakdown(events: EngagementEvent[]): InterestScore["breakdown"] {
  const postIds = new Set<string>();
  let totalDwell = 0;
  let rewatches = 0;
  let soundOns = 0;
  let profileClicks = 0;
  let hashtagClicks = 0;
  let saveClicks = 0;
  let shareClicks = 0;
  let commentOpens = 0;
  let captionExpands = 0;
  let videoPauses = 0;
  let likes = 0;

  for (const e of events) {
    postIds.add(e.postId);
    switch (e.eventType) {
      case "dwell": totalDwell += e.duration ?? 0; break;
      case "rewatch": rewatches++; break;
      case "sound_on": soundOns++; break;
      case "profile_click": profileClicks++; break;
      case "hashtag_click": hashtagClicks++; break;
      case "save_click": saveClicks++; break;
      case "share_click": shareClicks++; break;
      case "comment_open": commentOpens++; break;
      case "caption_expand": captionExpands++; break;
      case "video_pause": videoPauses++; break;
      case "like": likes++; break;
    }
  }

  return {
    totalDwell, rewatches, soundOns, profileClicks, hashtagClicks,
    saveClicks, shareClicks, commentOpens, captionExpands, videoPauses,
    likes, postCount: postIds.size,
  };
}

export function computeScores(
  allEvents: EngagementEvent[],
  existingScores: InterestScore[]
): InterestScore[] {
  const grouped = new Map<string, EngagementEvent[]>();
  for (const e of allEvents) {
    const key = e.destination.toLowerCase();
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(e);
  }

  const existingMap = new Map<string, InterestScore>();
  for (const s of existingScores) {
    existingMap.set(s.destination.toLowerCase(), s);
  }

  const rawScores = new Map<string, number>();
  const scoreEntries = new Map<string, InterestScore>();

  for (const [key, events] of grouped) {
    const raw = calculateRawScore(events);
    rawScores.set(key, raw);

    const existing = existingMap.get(key);
    const sample = events[0];

    scoreEntries.set(key, {
      destination: existing?.destination ?? sample.destination,
      country: existing?.country ?? "",
      countryCode: existing?.countryCode ?? sample.countryCode,
      airportCode: existing?.airportCode ?? null,
      score: 0,
      rawScore: raw,
      breakdown: buildBreakdown(events),
      flight: existing?.flight ?? null,
      lastUpdated: Date.now(),
    });
  }

  const maxRaw = Math.max(...rawScores.values(), 0);
  if (maxRaw > 0) {
    for (const [, entry] of scoreEntries) {
      entry.score = Math.round((entry.rawScore / maxRaw) * 100);
    }
  }

  return [...scoreEntries.values()].sort((a, b) => b.score - a.score);
}
