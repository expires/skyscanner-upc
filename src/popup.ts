import {
  DetectedEntry,
  InterestScore,
  WishlistEntry,
} from "./types.js";
import { CONFIG } from "./config.js";

function countryFlag(code: string | null): string {
  if (!code || code.length !== 2) return "";
  const offset = 0x1f1e6;
  const a = code.toUpperCase().charCodeAt(0) - 65 + offset;
  const b = code.toUpperCase().charCodeAt(1) - 65 + offset;
  return String.fromCodePoint(a) + String.fromCodePoint(b);
}

function sourceIcon(url: string): string {
  if (url.includes("tiktok.com")) return `<svg class="source-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1v-3.5a6.37 6.37 0 00-.79-.05A6.34 6.34 0 003.15 15.2a6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.34-6.34V8.71a8.19 8.19 0 004.76 1.52V6.79a4.85 4.85 0 01-1-.1z"/></svg>`;
  if (url.includes("instagram.com")) return `<svg class="source-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/></svg>`;
  return "";
}

function formatDuration(mins: number): string {
  if (!mins || mins <= 0) return "";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const feedEmpty = $<HTMLDivElement>("feed-empty");
const feedToolbar = $<HTMLDivElement>("feed-toolbar");
const feedCount = $<HTMLSpanElement>("feed-count");
const feedClear = $<HTMLButtonElement>("feed-clear");
const feedList = $<HTMLDivElement>("feed-list");
const tagSearchInput = $<HTMLInputElement>("tag-search");
const tagSuggestions = $<HTMLDivElement>("tag-suggestions");
const activeFilter = $<HTMLDivElement>("active-filter");
const filterText = $<HTMLSpanElement>("filter-text");
const filterClear = $<HTMLButtonElement>("filter-clear");
const rankedEmpty = $<HTMLDivElement>("ranked-empty");
const rankedList = $<HTMLDivElement>("ranked-list");
const savedEmpty = $<HTMLDivElement>("saved-empty");
const savedList = $<HTMLDivElement>("saved-list");
const btnSaveSettings = $<HTMLButtonElement>("btn-save-settings");
const settingsStatus = $<HTMLDivElement>("settings-status");
const inputGemini = $<HTMLInputElement>("input-gemini");
const inputSkyscanner = $<HTMLInputElement>("input-skyscanner");
const inputAirport = $<HTMLInputElement>("input-airport");

// --- Narrator ---
const narratorCard = $<HTMLDivElement>("narrator-card");
const narratorText = $<HTMLDivElement>("narrator-text");
const narratorError = $<HTMLDivElement>("narrator-error");
const narratorRefresh = $<HTMLButtonElement>("narrator-refresh");
const narratorGenerateWrap = $<HTMLDivElement>("narrator-generate-wrap");
const narratorGenerateBtn = $<HTMLButtonElement>("narrator-generate-btn");

let cachedNarrative: string | null = null;

// --- State ---
let activeTagFilter: string | null = null;
let allDetections: DetectedEntry[] = [];

// --- Tabs ---
document.querySelectorAll<HTMLButtonElement>(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`view-${tab.dataset.tab}`)?.classList.add("active");

    if (tab.dataset.tab === "ranked") renderRanked();
    if (tab.dataset.tab === "saved") renderSaved();
    if (tab.dataset.tab === "settings") loadSettings();
  });
});

// --- Tag search ---
function getAllTags(detections: DetectedEntry[]): string[] {
  const counts = new Map<string, number>();
  for (const d of detections) {
    for (const v of d.vibes) {
      const key = v.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  // Sort by frequency
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => key);
}

function renderSuggestions(query: string): void {
  const allTags = getAllTags(allDetections);
  const q = query.toLowerCase().trim();

  if (!q) {
    tagSuggestions.classList.remove("visible");
    return;
  }

  const matches = allTags.filter((t) => t.includes(q)).slice(0, 8);
  if (matches.length === 0) {
    tagSuggestions.classList.remove("visible");
    return;
  }

  tagSuggestions.classList.add("visible");
  tagSuggestions.innerHTML = "";
  matches.forEach((tag) => {
    const btn = document.createElement("button");
    btn.className = "tag-suggestion";
    btn.textContent = tag;
    btn.addEventListener("click", () => applyFilter(tag));
    tagSuggestions.appendChild(btn);
  });
}

function applyFilter(tag: string): void {
  activeTagFilter = tag.toLowerCase();
  tagSearchInput.value = "";
  tagSuggestions.classList.remove("visible");
  filterText.textContent = activeTagFilter;
  activeFilter.classList.add("visible");
  renderFeedList();
}

function clearFilter(): void {
  activeTagFilter = null;
  activeFilter.classList.remove("visible");
  tagSearchInput.value = "";
  renderFeedList();
}

tagSearchInput.addEventListener("input", () => {
  renderSuggestions(tagSearchInput.value);
});

tagSearchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const q = tagSearchInput.value.trim().toLowerCase();
    if (q) applyFilter(q);
  }
  if (e.key === "Escape") {
    clearFilter();
  }
});

filterClear.addEventListener("click", clearFilter);

// --- Score lookup cache ---
let cachedScores: InterestScore[] = [];

function getScoreForDest(destination: string): number {
  const match = cachedScores.find(
    (s) => s.destination.toLowerCase() === destination.toLowerCase()
  );
  return match?.score ?? 0;
}

// --- Feed ---
function renderFeedItem(
  entry: DetectedEntry,
  isSaved: boolean,
  isLoading: boolean
): HTMLDivElement {
  const item = document.createElement("div");
  item.className = "feed-item";
  item.dataset.destination = entry.destination.toLowerCase();

  let priceHtml: string;
  if (entry.flight) {
    priceHtml = `
      <a class="feed-price-link" href="${entry.flight.deeplink}" target="_blank" title="View on Skyscanner">
        <span class="feed-price">${entry.flight.price}</span>
        <span class="feed-currency">${entry.flight.currency}</span>
        <span class="feed-arrow">&nearr;</span>
      </a>`;
  } else if (isLoading) {
    priceHtml = `<div class="feed-price-skeleton">
        <span class="feed-price-skeleton-text">Searching...</span>
      </div>`;
  } else {
    priceHtml = "";
  }

  const dur = entry.flight ? formatDuration(entry.flight.durationMinutes) : "";
  const detailParts = [entry.flight?.airline, dur].filter(Boolean).join(" · ");
  const detailHtml = detailParts
    ? `<span class="feed-airline">${detailParts}</span>`
    : "";

  const vibesHtml = entry.vibes
    .map((v) => `<span class="vibe-tag">${v}</span>`)
    .join("");

  const score = getScoreForDest(entry.destination);
  const scoreBadge = score > 0
    ? `<span class="feed-score-badge">${score}</span>`
    : "";

  const mergedBadge = entry.mergedLocations && entry.mergedLocations.length > 1
    ? `<span class="merged-badge">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:2px"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>
        ${entry.mergedLocations.length} locations
        <span class="merged-tooltip">${entry.mergedLocations.join("<br/>")}</span>
      </span>`
    : "";

  item.innerHTML = `
    <span class="feed-flag">${countryFlag(entry.countryCode)}</span>
    <div class="feed-info">
      <div class="feed-dest">${entry.destination}${scoreBadge}${mergedBadge}</div>
      <div class="feed-meta">
        ${entry.country}
        <a href="${entry.sourceUrl}" target="_blank" class="source-link">${sourceIcon(entry.sourceUrl)}</a>
        ${entry.vibes.length > 0 ? `<button class="vibes-toggle" title="${entry.vibes.join(', ')}"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><circle cx="7" cy="7" r="1.5" fill="currentColor" stroke="none"/></svg> ${entry.vibes.length}</button>` : ""}
      </div>
      <div class="feed-vibes">${vibesHtml}</div>
    </div>
    <div class="feed-right">
      <div class="feed-price-row">
        ${priceHtml}
        <button class="feed-save ${isSaved ? "saved" : ""}" data-id="${entry.id}" title="${isSaved ? "Saved" : "Save to wishlist"}">
          &#9734;
        </button>
      </div>
      ${detailHtml}
    </div>
  `;

  // Toggle vibes on tag emoji click
  const toggle = item.querySelector(".vibes-toggle");
  const vibesEl = item.querySelector(".feed-vibes");
  if (toggle && vibesEl) {
    toggle.addEventListener("click", () => {
      vibesEl.classList.toggle("expanded");
    });
  }

  return item;
}

function renderFeedList(): void {
  const stored_wishlist = allDetections; // already loaded
  // We need wishlist + loading from last render call — store them
  renderFeedWithData();
}

let cachedWishlist: WishlistEntry[] = [];
let cachedLoadingDests: string[] = [];

async function renderFeed(): Promise<void> {
  const stored = await chrome.storage.local.get(["detections", "wishlist", "loadingDestinations", "interestScores"]);
  allDetections = stored.detections ?? [];
  cachedWishlist = stored.wishlist ?? [];
  cachedLoadingDests = stored.loadingDestinations ?? [];
  cachedScores = stored.interestScores ?? [];
  renderFeedWithData();
}

function renderFeedWithData(): void {
  const savedSet = new Set(cachedWishlist.map((w) => w.destination.toLowerCase()));
  const loadingSet = new Set(cachedLoadingDests.map((d: string) => d.toLowerCase()));

  // Apply tag filter
  let filtered = allDetections;
  if (activeTagFilter) {
    filtered = allDetections.filter((d) =>
      d.vibes.some((v) => v.toLowerCase().includes(activeTagFilter!))
    );
  }

  if (allDetections.length === 0) {
    feedEmpty.style.display = "block";
    feedToolbar.style.display = "none";
    feedList.innerHTML = "";
    return;
  }

  feedEmpty.style.display = "none";
  feedToolbar.style.display = "flex";

  const countLabel = activeTagFilter
    ? `${filtered.length} of ${allDetections.length} destinations`
    : `${allDetections.length} destination${allDetections.length !== 1 ? "s" : ""} detected`;
  feedCount.textContent = countLabel;

  feedList.innerHTML = "";

  filtered.forEach((entry) => {
    const isSaved = savedSet.has(entry.destination.toLowerCase());
    const isLoading = loadingSet.has(entry.destination.toLowerCase());
    const item = renderFeedItem(entry, isSaved, isLoading);
    feedList.appendChild(item);
  });

  // Save buttons — click to toggle save/unsave
  feedList.querySelectorAll<HTMLButtonElement>(".feed-save").forEach((btn) => {
    btn.addEventListener("click", () => toggleSave(btn));
  });
}

async function toggleSave(btn: HTMLButtonElement): Promise<void> {
  const id = btn.dataset.id;
  const stored = await chrome.storage.local.get(["detections", "wishlist"]);
  const detections: DetectedEntry[] = stored.detections ?? [];
  let wishlist: WishlistEntry[] = stored.wishlist ?? [];

  const entry = detections.find((d) => d.id === id);
  if (!entry) return;

  const destKey = entry.destination.toLowerCase();
  const alreadySaved = wishlist.some((w) => w.destination.toLowerCase() === destKey);

  if (alreadySaved) {
    // Unsave
    wishlist = wishlist.filter((w) => w.destination.toLowerCase() !== destKey);
    await chrome.storage.local.set({ wishlist });
    btn.classList.remove("saved");
  } else {
    // Save
    wishlist.push({
      id: crypto.randomUUID(),
      destination: entry.destination,
      country: entry.country,
      countryCode: entry.countryCode,
      vibes: entry.vibes,
      flight: entry.flight,
      sourceUrl: entry.sourceUrl,
      savedAt: Date.now(),
    });
    await chrome.storage.local.set({ wishlist });
    btn.classList.add("saved");
  }
}

feedClear.addEventListener("click", async () => {
  await chrome.storage.local.set({ detections: [] });
  clearFilter();
  renderFeed();
});

// --- Saved ---
async function renderSaved(): Promise<void> {
  const { wishlist = [] } = (await chrome.storage.local.get("wishlist")) as { wishlist: WishlistEntry[] };

  if (wishlist.length === 0) {
    savedEmpty.style.display = "block";
    savedList.style.display = "none";
    return;
  }

  savedEmpty.style.display = "none";
  savedList.style.display = "block";
  savedList.innerHTML = "";

  [...wishlist].sort((a, b) => b.savedAt - a.savedAt).forEach((entry) => {
    const item = document.createElement("div");
    item.className = "feed-item";

    const priceHtml = entry.flight
      ? `<a class="feed-price-link" href="${entry.flight.deeplink}" target="_blank">
           <span class="feed-price">${entry.flight.price}</span>
           <span class="feed-currency">${entry.flight.currency}</span>
           <span class="feed-arrow">&nearr;</span>
         </a>`
      : "";

    const dur = entry.flight ? formatDuration(entry.flight.durationMinutes) : "";
    const detailParts = [entry.flight?.airline, dur].filter(Boolean).join(" · ");
    const savedDetailHtml = detailParts
      ? `<span class="feed-airline">${detailParts}</span>`
      : "";

    const vibesHtml = entry.vibes
      .map((v) => `<span class="vibe-tag">${v}</span>`)
      .join("");

    item.innerHTML = `
      <span class="feed-flag">${countryFlag(entry.countryCode)}</span>
      <div class="feed-info">
        <div class="feed-dest">${entry.destination}</div>
        <div class="feed-meta">
          ${entry.country}
          <a href="${entry.sourceUrl}" target="_blank" class="source-link">${sourceIcon(entry.sourceUrl)}</a>
          ${entry.vibes.length > 0 ? `<button class="vibes-toggle" title="${entry.vibes.join(', ')}"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><circle cx="7" cy="7" r="1.5" fill="currentColor" stroke="none"/></svg> ${entry.vibes.length}</button>` : ""}
        </div>
        <div class="feed-vibes">${vibesHtml}</div>
      </div>
      <div class="feed-right">
        <div class="feed-price-row">
          ${priceHtml}
          <button class="wishlist-remove" data-id="${entry.id}" title="Remove">&times;</button>
        </div>
        ${savedDetailHtml}
      </div>
    `;

    const toggle = item.querySelector(".vibes-toggle");
    const vibesEl = item.querySelector(".feed-vibes");
    if (toggle && vibesEl) {
      toggle.addEventListener("click", () => {
        vibesEl.classList.toggle("expanded");
      });
    }

    savedList.appendChild(item);
  });

  savedList.querySelectorAll<HTMLButtonElement>(".wishlist-remove").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const { wishlist = [] } = (await chrome.storage.local.get("wishlist")) as { wishlist: WishlistEntry[] };
      await chrome.storage.local.set({ wishlist: wishlist.filter((e) => e.id !== id) });
      renderSaved();
    });
  });
}

const rankedReset = $<HTMLButtonElement>("ranked-reset");
const infoBtn = $<HTMLButtonElement>("info-btn");
const infoModal = $<HTMLDivElement>("info-modal");
const infoClose = $<HTMLButtonElement>("info-close");

infoBtn.addEventListener("click", () => infoModal.classList.add("visible"));
infoClose.addEventListener("click", () => infoModal.classList.remove("visible"));
infoModal.addEventListener("click", (e) => {
  if (e.target === infoModal) infoModal.classList.remove("visible");
});

rankedReset.addEventListener("click", async () => {
  await chrome.storage.local.set({ engagementLog: [], interestScores: [] });
  cachedNarrative = null;
  narratorCard.style.display = "none";
  narratorGenerateWrap.style.display = "none";
  renderRanked();
});

// --- AI Narrator ---

async function generateNarrative(scores: InterestScore[], force = false): Promise<void> {
  if (!force && cachedNarrative) return;

  const { GEMINI_API_KEY } = await chrome.storage.sync.get("GEMINI_API_KEY") as { GEMINI_API_KEY?: string };
  if (!GEMINI_API_KEY) {
    showNarratorError("Add your Gemini API key in Settings to enable AI insights.");
    return;
  }

  if (scores.length === 0) return;

  // Build prompt
  const destLines = scores
    .slice(0, 6)
    .map((s) => {
      const dwell = s.breakdown.totalDwell > 0
        ? `${Math.round(s.breakdown.totalDwell / 1000)}s dwell`
        : null;
      const posts = s.breakdown.postCount > 0
        ? `${s.breakdown.postCount} post${s.breakdown.postCount > 1 ? "s" : ""}`
        : null;
      const extras: string[] = [];
      if (s.breakdown.rewatches > 0) extras.push(`${s.breakdown.rewatches} rewatch${s.breakdown.rewatches > 1 ? "es" : ""}`);
      if ((s.breakdown as any).likes > 0) extras.push(`${(s.breakdown as any).likes} like${(s.breakdown as any).likes > 1 ? "s" : ""}`);
      if (s.breakdown.soundOns > 0) extras.push("sound on");
      const parts = [dwell, posts, ...extras].filter(Boolean).join(", ");
      return `${s.destination} (score ${s.score}/100${parts ? ": " + parts : ""})`;
    })
    .join("\n");

  const flightHint = (() => {
    const top = scores[0];
    if (top?.flight) {
      return `\nTop match flight: ${top.destination} at ${top.flight.price} ${top.flight.currency}.`;
    }
    return "";
  })();

  const prompt = `You are a travel insight narrator for a browser extension called Roam. Based on this user's engagement data from scrolling TikTok and Instagram, write 2–3 sentences summarising their travel intent. Be specific, warm, and insightful. No bullet points. No "Based on your data". Just speak naturally, like a friend who noticed what they've been watching — concise enough to fit a small popup card.${flightHint}

Top destinations by interest score:
${destLines}`;

  // UI: loading state
  setNarratorLoading(true);
  narratorCard.style.display = "block";
  narratorGenerateWrap.style.display = "none";
  
  // Show skeleton loader
  narratorText.innerHTML = `
    <div class="skeleton skeleton-line"></div>
    <div class="skeleton skeleton-line"></div>
    <div class="skeleton skeleton-line-last"></div>
  `;
  narratorText.classList.add("loading");
  narratorError.style.display = "none";

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI.NARRATOR_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: CONFIG.GEMINI.MAX_OUTPUT_TOKENS, temperature: CONFIG.GEMINI.TEMPERATURE },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini ${res.status}: ${errText.slice(0, 120)}`);
    }

    const data = await res.json();
    const raw: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    if (!raw.trim()) throw new Error("Empty response from Gemini.");

    // Clean up any markdown the model may include
    const cleaned = raw
      .replace(/^#+\s*/gm, "")
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/\*(.*?)\*/g, "$1")
      .trim();

    cachedNarrative = cleaned;
    narratorText.textContent = cleaned;
    narratorText.classList.remove("loading");
  } catch (err: any) {
    narratorText.textContent = "";
    narratorText.classList.remove("loading");
    showNarratorError(err?.message ?? "Something went wrong. Try again.");
  } finally {
    setNarratorLoading(false);
  }
}

function setNarratorLoading(on: boolean): void {
  narratorRefresh.disabled = on;
  narratorGenerateBtn.disabled = on;
  if (on) {
    narratorRefresh.classList.add("spinning");
    narratorGenerateBtn.classList.add("spinning");
  } else {
    narratorRefresh.classList.remove("spinning");
    narratorGenerateBtn.classList.remove("spinning");
  }
}

function showNarratorError(msg: string): void {
  narratorError.textContent = msg;
  narratorError.style.display = "block";
  // Show the card so the error is visible
  narratorCard.style.display = "block";
  narratorGenerateWrap.style.display = "none";
}

narratorRefresh.addEventListener("click", async () => {
  const { interestScores = [] } = await chrome.storage.local.get("interestScores") as { interestScores: InterestScore[] };
  if (interestScores.length > 0) generateNarrative(interestScores, true);
});

narratorGenerateBtn.addEventListener("click", async () => {
  const { interestScores = [] } = await chrome.storage.local.get("interestScores") as { interestScores: InterestScore[] };
  if (interestScores.length > 0) generateNarrative(interestScores, true);
});

// --- Ranked ---
function formatDwell(ms: number): string {
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return remSecs > 0 ? `${mins}m ${remSecs}s` : `${mins}m`;
}

async function renderRanked(): Promise<void> {
  const { interestScores = [], detections = [] } = await chrome.storage.local.get(["interestScores", "detections"]) as { interestScores: InterestScore[], detections: DetectedEntry[] };

  // Live-merge latest flight and location data from detections
  // because engagement events often happen before flight searches finish
  const validScores: InterestScore[] = [];
  for (const score of interestScores) {
    const match = detections.find((d) =>
      d.destination.toLowerCase() === score.destination.toLowerCase() ||
      (d.airportCode && d.airportCode === score.airportCode)
    );
    if (match) {
      if (!score.country) score.country = match.country;
      if (!score.airportCode) score.airportCode = match.airportCode;
      if (match.flight) score.flight = match.flight;
      if (match.mergedLocations) score.mergedLocations = match.mergedLocations;
      validScores.push(score);
    }
  }

  if (validScores.length === 0) {
    rankedEmpty.style.display = "block";
    rankedList.style.display = "none";
    narratorCard.style.display = "none";
    narratorGenerateWrap.style.display = "none";
    return;
  }

  rankedEmpty.style.display = "none";
  rankedList.style.display = "block";

  // Show narrator card if we already have a narrative, otherwise show the generate button
  if (cachedNarrative) {
    narratorCard.style.display = "block";
    narratorText.textContent = cachedNarrative;
    narratorText.classList.remove("loading");
    narratorGenerateWrap.style.display = "none";
  } else {
    narratorCard.style.display = "none";
    narratorGenerateWrap.style.display = "block";
  }
  rankedList.innerHTML = "";

  validScores.forEach((entry) => {
    const item = document.createElement("div");
    item.className = "ranked-item";

    // Build summary line
    const summaryParts: string[] = [];
    if (entry.breakdown.totalDwell > 0) summaryParts.push(`${formatDwell(entry.breakdown.totalDwell)} dwell`);
    if (entry.breakdown.likes > 0) summaryParts.push(`${entry.breakdown.likes} like${entry.breakdown.likes > 1 ? "s" : ""}`);
    if (entry.breakdown.rewatches > 0) summaryParts.push(`${entry.breakdown.rewatches} rewatch${entry.breakdown.rewatches > 1 ? "es" : ""}`);
    if (entry.breakdown.saveClicks > 0) summaryParts.push(`${entry.breakdown.saveClicks} save${entry.breakdown.saveClicks > 1 ? "s" : ""}`);
    if (entry.breakdown.postCount > 1) summaryParts.push(`${entry.breakdown.postCount} posts`);
    const summaryText = summaryParts.join(" · ") || "Tap to see breakdown";

    // Build detailed breakdown rows
    const b = entry.breakdown;
    const rows: { label: string; value: string; highlight?: boolean }[] = [];
    if (b.totalDwell > 0) rows.push({ label: "Time spent", value: formatDwell(b.totalDwell), highlight: true });
    if (b.postCount > 0) rows.push({ label: "Posts seen", value: `${b.postCount}` });
    if (b.likes > 0) rows.push({ label: "Likes", value: `${b.likes}`, highlight: true });
    if (b.rewatches > 0) rows.push({ label: "Rewatches", value: `${b.rewatches}`, highlight: true });
    if (b.saveClicks > 0) rows.push({ label: "Saves", value: `${b.saveClicks}`, highlight: true });
    if (b.shareClicks > 0) rows.push({ label: "Shares", value: `${b.shareClicks}`, highlight: true });
    if (b.profileClicks > 0) rows.push({ label: "Profile clicks", value: `${b.profileClicks}` });
    if (b.hashtagClicks > 0) rows.push({ label: "Hashtag clicks", value: `${b.hashtagClicks}` });
    if (b.soundOns > 0) rows.push({ label: "Sound on", value: `${b.soundOns}` });
    if (b.commentOpens > 0) rows.push({ label: "Comments opened", value: `${b.commentOpens}` });
    if (b.captionExpands > 0) rows.push({ label: "Captions expanded", value: `${b.captionExpands}` });
    if (b.videoPauses > 0) rows.push({ label: "Video pauses", value: `${b.videoPauses}` });
    rows.push({ label: "Raw score", value: `${Math.round(entry.rawScore * 10) / 10}` });

    const detailRowsHtml = rows.map((r) =>
      `<div class="ranked-breakdown-row">
        <span class="ranked-breakdown-label">${r.label}</span>
        <span class="ranked-breakdown-value${r.highlight ? " highlight" : ""}">${r.value}</span>
      </div>`
    ).join("");

    const mergedBadge = entry.mergedLocations && entry.mergedLocations.length > 1
      ? `<span class="merged-badge">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:2px"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>
          ${entry.mergedLocations.length} locations
          <span class="merged-tooltip">${entry.mergedLocations.join("<br/>")}</span>
        </span>`
      : "";

    const priceHtml = entry.flight
      ? `<a class="feed-price-link" href="${entry.flight.deeplink}" target="_blank">
           <span class="feed-price">${entry.flight.price}</span>
           <span class="feed-currency">${entry.flight.currency}</span>
           <span class="feed-arrow">&nearr;</span>
         </a>`
      : "";

    item.innerHTML = `
      <div class="ranked-top">
        <span class="ranked-flag">${countryFlag(entry.countryCode)}</span>
        <div class="ranked-info">
          <div class="ranked-dest">${entry.destination}${mergedBadge}</div>
          <div class="feed-meta" style="margin-bottom: 4px;">${entry.country}</div>
          <div class="ranked-bar-row">
            <div class="ranked-bar-track">
              <div class="ranked-bar-fill" style="width: ${entry.score}%"></div>
            </div>
            <span class="ranked-score">${entry.score}</span>
          </div>
          <div class="ranked-bar-label">Intent score</div>
        </div>
        <div class="feed-right" style="margin-top: 0">
          <div class="feed-price-row">
            ${priceHtml}
          </div>
        </div>
      </div>
      <button class="ranked-breakdown-toggle">
        ${summaryText} <span class="ranked-breakdown-chevron">&#9660;</span>
      </button>
      <div class="ranked-breakdown-detail">
        ${detailRowsHtml}
      </div>
    `;

    // Wire toggle
    const toggle = item.querySelector(".ranked-breakdown-toggle")!;
    const detail = item.querySelector(".ranked-breakdown-detail")!;
    toggle.addEventListener("click", () => {
      toggle.classList.toggle("expanded");
      detail.classList.toggle("visible");
    });

    rankedList.appendChild(item);
  });
}

// --- Settings ---
const inputCurrency = $<HTMLSelectElement>("input-currency");

async function loadSettings(): Promise<void> {
  const s = await chrome.storage.sync.get(["GEMINI_API_KEY", "SKYSCANNER_API_KEY", "HOME_AIRPORT", "CURRENCY"]);
  inputGemini.value = s.GEMINI_API_KEY ?? "";
  inputSkyscanner.value = s.SKYSCANNER_API_KEY ?? "";
  inputAirport.value = s.HOME_AIRPORT ?? "";
  inputCurrency.value = s.CURRENCY ?? "EUR";
}

btnSaveSettings.addEventListener("click", async () => {
  await chrome.storage.sync.set({
    GEMINI_API_KEY: inputGemini.value.trim(),
    SKYSCANNER_API_KEY: inputSkyscanner.value.trim(),
    HOME_AIRPORT: inputAirport.value.trim().toUpperCase(),
    CURRENCY: inputCurrency.value,
  });
  settingsStatus.style.display = "block";
  setTimeout(() => { settingsStatus.style.display = "none"; }, 2000);
});

// --- Live updates ---
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.detections || changes.loadingDestinations || changes.interestScores) renderFeed();
  if (changes.interestScores) renderRanked();
});

// --- Init ---
renderFeed();
