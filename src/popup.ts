import {
  DetectedEntry,
  WishlistEntry,
} from "./types.js";

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
const savedEmpty = $<HTMLDivElement>("saved-empty");
const savedList = $<HTMLDivElement>("saved-list");
const btnSaveSettings = $<HTMLButtonElement>("btn-save-settings");
const settingsStatus = $<HTMLDivElement>("settings-status");
const inputAnthropic = $<HTMLInputElement>("input-anthropic");
const inputSkyscanner = $<HTMLInputElement>("input-skyscanner");
const inputAirport = $<HTMLInputElement>("input-airport");

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
    priceHtml = `<span class="feed-price-link" style="opacity:0.4;pointer-events:none;">
        <span class="feed-currency">searching...</span>
      </span>`;
  } else {
    priceHtml = "";
  }

  const dur = entry.flight ? formatDuration(entry.flight.durationMinutes) : "";
  const detailParts = [entry.flight?.airline, dur].filter(Boolean).join(" · ");
  const detailHtml = detailParts
    ? `<span class="feed-airline">${detailParts}</span>`
    : "";

  const loadingHtml = isLoading
    ? `<div class="feed-loading"><div class="feed-loading-bar"></div></div>`
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
        ${entry.vibes.length > 0 ? `<button class="vibes-toggle" title="${entry.vibes.join(', ')}">🏷 ${entry.vibes.length}</button>` : ""}
      </div>
      <div class="feed-vibes">${vibesHtml}</div>
    </div>
    <div class="feed-right">
      <div class="feed-price-row">
        ${priceHtml}
        <button class="feed-save ${isSaved ? "saved" : ""}" data-id="${entry.id}" title="${isSaved ? "Saved" : "Save to wishlist"}">
          ${isSaved ? "&#10003;" : "&#9734;"}
        </button>
      </div>
      ${detailHtml}
    </div>
    ${loadingHtml}
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
  const stored = await chrome.storage.local.get(["detections", "wishlist", "loadingDestinations"]);
  allDetections = stored.detections ?? [];
  cachedWishlist = stored.wishlist ?? [];
  cachedLoadingDests = stored.loadingDestinations ?? [];
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

  // Save buttons
  feedList.querySelectorAll<HTMLButtonElement>(".feed-save").forEach((btn) => {
    if (btn.classList.contains("saved")) return;
    btn.addEventListener("click", () => saveFromFeed(btn));
  });
}

async function saveFromFeed(btn: HTMLButtonElement): Promise<void> {
  const id = btn.dataset.id;
  const stored = await chrome.storage.local.get(["detections", "wishlist"]);
  const detections: DetectedEntry[] = stored.detections ?? [];
  const wishlist: WishlistEntry[] = stored.wishlist ?? [];

  const entry = detections.find((d) => d.id === id);
  if (!entry) return;

  if (wishlist.some((w) => w.destination.toLowerCase() === entry.destination.toLowerCase())) return;

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

  btn.innerHTML = "&#10003;";
  btn.classList.add("saved");
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
          ${entry.vibes.length > 0 ? `<button class="vibes-toggle" title="${entry.vibes.join(', ')}">🏷 ${entry.vibes.length}</button>` : ""}
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

// --- Settings ---
const inputCurrency = $<HTMLSelectElement>("input-currency");

async function loadSettings(): Promise<void> {
  const s = await chrome.storage.sync.get(["ANTHROPIC_API_KEY", "SKYSCANNER_API_KEY", "HOME_AIRPORT", "CURRENCY"]);
  inputAnthropic.value = s.ANTHROPIC_API_KEY ?? "";
  inputSkyscanner.value = s.SKYSCANNER_API_KEY ?? "";
  inputAirport.value = s.HOME_AIRPORT ?? "";
  inputCurrency.value = s.CURRENCY ?? "EUR";
}

btnSaveSettings.addEventListener("click", async () => {
  await chrome.storage.sync.set({
    ANTHROPIC_API_KEY: inputAnthropic.value.trim(),
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
  if (changes.detections || changes.loadingDestinations) renderFeed();
});

// --- Init ---
renderFeed();
