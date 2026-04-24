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

function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
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
const savedEmpty = $<HTMLDivElement>("saved-empty");
const savedList = $<HTMLDivElement>("saved-list");
const btnSaveSettings = $<HTMLButtonElement>("btn-save-settings");
const settingsStatus = $<HTMLDivElement>("settings-status");
const inputAnthropic = $<HTMLInputElement>("input-anthropic");
const inputSkyscanner = $<HTMLInputElement>("input-skyscanner");
const inputAirport = $<HTMLInputElement>("input-airport");

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

// --- Feed ---
function renderFeedItem(
  entry: DetectedEntry,
  isSaved: boolean,
  isLoading: boolean
): HTMLDivElement {
  const item = document.createElement("div");
  item.className = "feed-item";
  item.dataset.destination = entry.destination.toLowerCase();

  const vibesHtml = entry.vibes
    .map((v) => `<span class="vibe-tag">${v}</span>`)
    .join("");

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

  item.innerHTML = `
    <span class="feed-flag">${countryFlag(entry.countryCode)}</span>
    <div class="feed-info">
      <div class="feed-dest">${entry.destination}</div>
      <div class="feed-meta">
        ${entry.country} &middot; ${timeAgo(entry.detectedAt)}
        &middot; <a href="${entry.sourceUrl}" target="_blank">source</a>
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

  return item;
}

async function renderFeed(): Promise<void> {
  const stored = await chrome.storage.local.get(["detections", "wishlist", "loadingDestination"]);
  const detections: DetectedEntry[] = stored.detections ?? [];
  const wishlist: WishlistEntry[] = stored.wishlist ?? [];
  const loadingDest: string | null = stored.loadingDestination ?? null;

  const savedSet = new Set(wishlist.map((w) => w.destination.toLowerCase()));

  if (detections.length === 0) {
    feedEmpty.style.display = "block";
    feedToolbar.style.display = "none";
    feedList.innerHTML = "";
    return;
  }

  feedEmpty.style.display = "none";
  feedToolbar.style.display = "flex";
  feedCount.textContent = `${detections.length} destination${detections.length !== 1 ? "s" : ""} detected`;
  feedList.innerHTML = "";

  detections.forEach((entry) => {
    const isSaved = savedSet.has(entry.destination.toLowerCase());
    const isLoading = loadingDest?.toLowerCase() === entry.destination.toLowerCase();
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

    const vibesHtml = entry.vibes.map((v) => `<span class="vibe-tag">${v}</span>`).join("");

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

    item.innerHTML = `
      <span class="feed-flag">${countryFlag(entry.countryCode)}</span>
      <div class="feed-info">
        <div class="feed-dest">${entry.destination}</div>
        <div class="feed-meta">
          ${entry.country}
          &middot; <a href="${entry.sourceUrl}" target="_blank">source</a>
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
async function loadSettings(): Promise<void> {
  const s = await chrome.storage.sync.get(["ANTHROPIC_API_KEY", "SKYSCANNER_API_KEY", "HOME_AIRPORT"]);
  inputAnthropic.value = s.ANTHROPIC_API_KEY ?? "";
  inputSkyscanner.value = s.SKYSCANNER_API_KEY ?? "";
  inputAirport.value = s.HOME_AIRPORT ?? "";
}

btnSaveSettings.addEventListener("click", async () => {
  await chrome.storage.sync.set({
    ANTHROPIC_API_KEY: inputAnthropic.value.trim(),
    SKYSCANNER_API_KEY: inputSkyscanner.value.trim(),
    HOME_AIRPORT: inputAirport.value.trim().toUpperCase(),
  });
  settingsStatus.style.display = "block";
  setTimeout(() => { settingsStatus.style.display = "none"; }, 2000);
});

// --- Live updates ---
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.detections || changes.loadingDestination) renderFeed();
});

// --- Init ---
renderFeed();
