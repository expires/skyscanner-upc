import { EngagementEvent, InterestScore } from "./types.js";
import { CONFIG } from "./config.js";

// Non-linear dwell logic using CONFIG
function dwellScore(durationMs: number): number {
  const secs = durationMs / 1000;
  const { THRESHOLDS_SEC: T, MULTIPLIERS: M } = CONFIG.SCORING.DWELL;
  const baseWeight = CONFIG.SCORING.WEIGHTS.dwell;

  if (secs <= T.FIRST) return secs * baseWeight * M.BASE;
  if (secs <= T.SECOND) return (T.FIRST * baseWeight * M.BASE) + ((secs - T.FIRST) * baseWeight * M.SECOND);
  if (secs <= T.THIRD) return (T.FIRST * baseWeight * M.BASE) + ((T.SECOND - T.FIRST) * baseWeight * M.SECOND) + ((secs - T.SECOND) * baseWeight * M.THIRD);
  
  return (T.FIRST * baseWeight * M.BASE) + 
         ((T.SECOND - T.FIRST) * baseWeight * M.SECOND) + 
         ((T.THIRD - T.SECOND) * baseWeight * M.THIRD) + 
         ((secs - T.THIRD) * baseWeight * M.FOURTH);
}

export function calculateRawScore(events: EngagementEvent[]): number {
  const now = Date.now();

  // Count unique posts for multi-post bonus
  const uniquePosts = new Set(events.map((e) => e.postId));
  const multiPostBonus = Math.max(0, uniquePosts.size - 1) * CONFIG.SCORING.MULTI_POST_BONUS;

  const eventScore = events.reduce((total, event) => {
    const age = now - event.timestamp;
    const decayFactor = Math.pow(0.5, age / CONFIG.SCORING.DECAY_HALF_LIFE_MS);

    if (event.eventType === "dwell" && event.duration) {
      return total + dwellScore(event.duration) * decayFactor;
    }
    return total + (CONFIG.SCORING.WEIGHTS[event.eventType] ?? 0) * decayFactor;
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
      mergedLocations: existing?.mergedLocations ?? [],
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
