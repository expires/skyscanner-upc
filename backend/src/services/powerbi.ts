import { EventDocument, ScoreDocument } from '../db/mongo';

export async function streamEventsToPowerBI(
  events: EventDocument[]
): Promise<void> {
  const EVENTS_URL = process.env.POWER_BI_EVENTS_URL;
  if (!EVENTS_URL) return; // graceful skip if not configured

  const rows = events.map(e => ({
    destination: e.destination,
    country: e.countryCode, // Power BI expects country column
    countryCode: e.countryCode,
    eventType: e.eventType,
    platform: e.platform,
    dwellSeconds: e.duration ? Math.round(e.duration / 1000) : 0,
    timestamp: new Date(e.timestamp).toISOString(),
    deviceId: e.deviceId,
  }));

  try {
    await fetch(EVENTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rows),
    });
  } catch (err) {
    console.warn('[Roam] Power BI events stream failed silently', err);
    // never block main flow on analytics
  }
}

export async function streamScoresToPowerBI(
  deviceId: string,
  scores: ScoreDocument[]
): Promise<void> {
  const SCORES_URL = process.env.POWER_BI_SCORES_URL;
  if (!SCORES_URL) return;

  const rows = scores.map(s => ({
    destination: s.destination,
    country: s.country,
    countryCode: s.countryCode,
    intentScore: s.score,
    rawScore: Math.round(s.rawScore),
    totalDwellSeconds: Math.round(s.breakdown.totalDwell / 1000),
    postCount: s.breakdown.postCount,
    saves: s.breakdown.saveClicks ?? 0, // Using saveClicks based on types
    rewatches: s.breakdown.rewatches,
    profileClicks: s.breakdown.profileClicks,
    timestamp: new Date().toISOString(),
    deviceId,
  }));

  try {
    await fetch(SCORES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rows),
    });
  } catch (err) {
    console.warn('[Roam] Power BI scores stream failed silently', err);
  }
}
