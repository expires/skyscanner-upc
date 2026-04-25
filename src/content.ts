// No imports — content scripts run as plain scripts, not ES modules.

interface ContentPayload {
  type: "CONTENT_DETECTED";
  description: string;
  hashtags: string[];
  locationTag: string | null;
  pageUrl: string;
  trigger: "text_change" | "slide_change" | "video_tick";
}

// --- Config ---
const TEXT_DEBOUNCE_MS = 800;
const VIDEO_TICK_MS = 1000;
const SLIDE_DEBOUNCE_MS = 400;

// --- State ---
let textDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let slideDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let videoTickInterval: ReturnType<typeof setInterval> | null = null;
let lastSentKey = "";
let lastSlideIndex = -1;
let currentPostId = "";
let postFinished = false; // true once the video has ended for this post
let currentVideo: HTMLVideoElement | null = null;

function isTikTok(): boolean {
  return location.hostname.includes("tiktok.com");
}

function isInstagram(): boolean {
  return location.hostname.includes("instagram.com");
}

// --- Text Extraction ---

function extractTikTok(): ContentPayload | null {
  const descEl =
    document.querySelector('[data-e2e="browse-video-desc"]') ??
    document.querySelector('[data-e2e="video-desc"]') ??
    document.querySelector('[class*="DivVideoInfoContainer"] [class*="SpanText"]') ??
    document.querySelector('[class*="tiktok-"][class*="DivContainer"] > span');

  const fallbackDesc = descEl ?? document.querySelector('[class*="desc"][class*="video" i]');
  if (!fallbackDesc) return null;

  const description = fallbackDesc.textContent?.trim() ?? "";

  const hashtagEls =
    fallbackDesc.querySelectorAll("a[href*='/tag/']").length > 0
      ? fallbackDesc.querySelectorAll("a[href*='/tag/']")
      : document.querySelectorAll("a[href*='/tag/']");
  const hashtags = Array.from(hashtagEls).map((el) => el.textContent?.trim() ?? "");

  const locationEl =
    document.querySelector('[data-e2e="browse-video-location"]') ??
    document.querySelector('[data-e2e="video-location"]') ??
    document.querySelector('a[href*="/location/"]');
  const locationTag = locationEl?.textContent?.trim() ?? null;

  if (!description && hashtags.length === 0) return null;

  return {
    type: "CONTENT_DETECTED",
    description,
    hashtags,
    locationTag,
    pageUrl: location.href,
    trigger: "text_change",
  };
}

function extractInstagram(): ContentPayload | null {
  const captionEl =
    document.querySelector("h1._ap3a") ??
    document.querySelector('[class*="Caption"] span') ??
    document.querySelector('div[role="button"] span[dir="auto"]') ??
    document.querySelector("article span[dir='auto']") ??
    document.querySelector("ul li span[dir='auto']");

  if (!captionEl) return null;

  const description = captionEl.textContent?.trim() ?? "";
  const hashtagMatches = description.match(/#\w+/g) ?? [];
  const hashtags = hashtagMatches.map((h) => h);

  const locationEl =
    document.querySelector("a[href*='/explore/locations/']") ??
    document.querySelector("a[href*='/locations/']");
  const locationTag = locationEl?.textContent?.trim() ?? null;

  if (!description) return null;

  return {
    type: "CONTENT_DETECTED",
    description,
    hashtags,
    locationTag,
    pageUrl: location.href,
    trigger: "text_change",
  };
}

function extractContent(): ContentPayload | null {
  if (isTikTok()) return extractTikTok();
  if (isInstagram()) return extractInstagram();
  return null;
}

// --- Send to background ---

function sendPayload(payload: ContentPayload): void {
  if (postFinished) return;
  console.log(`[Roam] Sending (${payload.trigger}):`, payload.description.slice(0, 50));
  chrome.runtime.sendMessage(payload);
}

// --- Post change detection (new video / new post scrolled into view) ---

function getPostId(): string {
  if (isTikTok()) {
    // TikTok video ID from URL or from a data attribute
    const match = location.href.match(/\/video\/(\d+)/);
    if (match) return match[1];
    // Fallback: use the description text as a fingerprint
    const desc = document.querySelector('[data-e2e="browse-video-desc"]')?.textContent ?? "";
    return desc.slice(0, 60);
  }
  if (isInstagram()) {
    const match = location.href.match(/\/(reel|p)\/([^/]+)/);
    if (match) return match[2];
    const desc = document.querySelector("article span[dir='auto']")?.textContent ?? "";
    return desc.slice(0, 60);
  }
  return "";
}

function onVideoEnded(): void {
  console.log("[Roam] Video ended, stopping actions for this post");
  postFinished = true;
  stopVideoTick();
}

function handlePostChange(): void {
  const newPostId = getPostId();
  if (!newPostId) return;

  if (newPostId !== currentPostId) {
    currentPostId = newPostId;
    lastSentKey = "";
    lastSlideIndex = -1;
    postFinished = false;
    console.log("[Roam] New post detected:", newPostId.slice(0, 30));

    // Detach previous video listener
    if (currentVideo) {
      currentVideo.removeEventListener("ended", onVideoEnded);
      currentVideo = null;
    }

    // Stop previous video tick
    stopVideoTick();

    // Extract text and send
    handleTextChange();

    // Attach ended listener and start tick if video
    const video = document.querySelector("video");
    if (video) {
      currentVideo = video;
      video.addEventListener("ended", onVideoEnded);
      startVideoTickIfNeeded();
    }
  }
}

// --- Text change (debounced) ---

function handleTextChange(): void {
  const payload = extractContent();
  if (!payload) return;

  const textKey = payload.description + payload.hashtags.join(",");

  if (textDebounceTimer) clearTimeout(textDebounceTimer);

  textDebounceTimer = setTimeout(() => {
    // Always send on new post even if same text (screenshot will differ)
    if (textKey === lastSentKey && payload.trigger === "text_change") return;
    lastSentKey = textKey;
    sendPayload(payload);
  }, TEXT_DEBOUNCE_MS);
}

// --- Slide / carousel detection ---

function getCurrentSlideIndex(): number {
  if (isTikTok()) {
    // TikTok slideshows have dot indicators or slide counters
    const activeIndicator = document.querySelector(
      '[class*="SlideIndicator"] [class*="active"], [class*="DivDotItem"][class*="active"]'
    );
    if (activeIndicator?.parentElement) {
      return Array.from(activeIndicator.parentElement.children).indexOf(activeIndicator);
    }
    // Fallback: look for "X/Y" counter text
    const counter = document.querySelector('[class*="SlideCount"], [class*="ImageCount"]');
    if (counter) {
      const match = counter.textContent?.match(/(\d+)\s*[/\/]\s*\d+/);
      if (match) return parseInt(match[1], 10);
    }
  }
  if (isInstagram()) {
    // Instagram carousels have dot indicators
    const dots = document.querySelectorAll('[class*="CarouselIndicator"] div, [role="tablist"] [role="tab"]');
    for (let i = 0; i < dots.length; i++) {
      if (dots[i].getAttribute("aria-selected") === "true" ||
          dots[i].classList.toString().includes("active")) {
        return i;
      }
    }
  }
  return 0;
}

function handleSlideChange(): void {
  const slideIdx = getCurrentSlideIndex();
  if (slideIdx === lastSlideIndex) return;
  lastSlideIndex = slideIdx;

  if (slideDebounceTimer) clearTimeout(slideDebounceTimer);

  slideDebounceTimer = setTimeout(() => {
    const payload = extractContent();
    if (!payload) return;
    payload.trigger = "slide_change";
    console.log("[Roam] Slide changed to index:", slideIdx);
    sendPayload(payload);
  }, SLIDE_DEBOUNCE_MS);
}

// --- Video tick — simple 1s interval ---

function startVideoTickIfNeeded(): void {
  stopVideoTick();

  videoTickInterval = setInterval(() => {
    const payload = extractContent();
    if (!payload) return;
    payload.trigger = "video_tick";
    sendPayload(payload);
  }, VIDEO_TICK_MS);
}

function stopVideoTick(): void {
  if (videoTickInterval) {
    clearInterval(videoTickInterval);
    videoTickInterval = null;
  }
}

// --- Click listener for slide navigation ---

document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;

  // Detect clicks on slideshow arrows / navigation buttons
  const isNavClick =
    target.closest("button[aria-label*='next' i]") ??
    target.closest("button[aria-label*='previous' i]") ??
    target.closest("button[aria-label*='Go to slide' i]") ??
    target.closest('[class*="Arrow"]') ??
    target.closest('[class*="SlideNav"]') ??
    target.closest('[class*="carousel" i] button') ??
    target.closest('[data-e2e*="arrow"]');

  if (isNavClick) {
    // Wait a moment for the slide to animate
    setTimeout(() => handleSlideChange(), 300);
  }
}, true);

// --- MutationObserver (existing) ---

const observer = new MutationObserver(() => {
  handlePostChange();
  // Also check for slide changes on DOM mutations (some carousels don't use click)
  handleSlideChange();
});

observer.observe(document.body, {
  childList: true,
  subtree: true,
  characterData: true,
});

// --- Init ---
console.log("[Roam] Content script loaded on", location.hostname);
handlePostChange();
