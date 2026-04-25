// No imports — content scripts run as plain scripts, not ES modules.

interface ContentPayload {
  type: "CONTENT_DETECTED";
  description: string;
  hashtags: string[];
  locationTag: string | null;
  pageUrl: string;
  postId: string;
  slideIndex: number;
  trigger: "text_change" | "slide_change" | "video_tick";
}

// --- Config ---
const TEXT_DEBOUNCE_MS = 800;
const VIDEO_TICK_MS = 1000;
const SLIDE_DEBOUNCE_MS = 400;
const AFK_THRESHOLD_MS = 20_000; // dwell idle tail stripped after 20s of no input

// --- State ---
let textDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let slideDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let videoTickInterval: ReturnType<typeof setInterval> | null = null;
let lastSentKey = "";
let lastSlideIndex = -1;
let currentPostId = "";
let postFinished = false; // true once the video has ended for this post
let currentVideo: HTMLVideoElement | null = null;
let localSlideCounter = 0; // incremented on each carousel nav click

// --- AFK tracking ---
let lastActivityTime = Date.now();

function refreshActivity(): void {
  lastActivityTime = Date.now();
}

// Any of these events count as "active" — mouse, touch, keyboard, or scroll
document.addEventListener("mousemove", refreshActivity, { passive: true, capture: true });
document.addEventListener("touchstart", refreshActivity, { passive: true, capture: true });
document.addEventListener("keydown", refreshActivity, { passive: true, capture: true });
document.addEventListener("scroll", refreshActivity, { passive: true, capture: true });

function isTikTok(): boolean {
  return location.hostname.includes("tiktok.com");
}

function isInstagram(): boolean {
  return location.hostname.includes("instagram.com");
}

// --- Text Extraction ---

function extractTikTok(): ContentPayload {
  const descEl =
    document.querySelector('[data-e2e="browse-video-desc"]') ??
    document.querySelector('[data-e2e="video-desc"]') ??
    document.querySelector('[class*="DivVideoInfoContainer"] [class*="SpanText"]') ??
    document.querySelector('[class*="tiktok-"][class*="DivContainer"] > span');

  const fallbackDesc = descEl ?? document.querySelector('[class*="desc"][class*="video" i]');
  const description = fallbackDesc?.textContent?.trim() ?? "";

  const hashtagEls =
    fallbackDesc && fallbackDesc.querySelectorAll("a[href*='/tag/']").length > 0
      ? fallbackDesc.querySelectorAll("a[href*='/tag/']")
      : document.querySelectorAll("a[href*='/tag/']");
  const hashtags = Array.from(hashtagEls).map((el) => el.textContent?.trim() ?? "");

  const locationEl =
    document.querySelector('[data-e2e="browse-video-location"]') ??
    document.querySelector('[data-e2e="video-location"]') ??
    document.querySelector('a[href*="/location/"]');
  const locationTag = locationEl?.textContent?.trim() ?? null;

  return {
    type: "CONTENT_DETECTED",
    description,
    hashtags,
    locationTag,
    pageUrl: location.href,
    postId: currentPostId,
    slideIndex: getCurrentSlideIndex(),
    trigger: "text_change",
  };
}

function extractInstagram(): ContentPayload {
  const captionEl =
    document.querySelector("h1._ap3a") ??
    document.querySelector('[class*="Caption"] span') ??
    document.querySelector('div[role="button"] span[dir="auto"]') ??
    document.querySelector("article span[dir='auto']") ??
    document.querySelector("ul li span[dir='auto']");

  const description = captionEl?.textContent?.trim() ?? "";
  const hashtagMatches = description.match(/#\w+/g) ?? [];
  const hashtags = hashtagMatches.map((h) => h);

  const locationEl =
    document.querySelector("a[href*='/explore/locations/']") ??
    document.querySelector("a[href*='/locations/']");
  const locationTag = locationEl?.textContent?.trim() ?? null;

  return {
    type: "CONTENT_DETECTED",
    description,
    hashtags,
    locationTag,
    pageUrl: location.href,
    postId: currentPostId,
    slideIndex: getCurrentSlideIndex(),
    trigger: "text_change",
  };
}

function extractContent(): ContentPayload {
  // Always returns a payload — text fields may be empty if not found.
  // Screenshot is the primary detection signal; text is supplementary context.
  if (isTikTok()) return extractTikTok();
  if (isInstagram()) return extractInstagram();
  // Fallback: empty payload so screenshot can still be taken
  return {
    type: "CONTENT_DETECTED",
    description: "",
    hashtags: [],
    locationTag: null,
    pageUrl: location.href,
    postId: currentPostId,
    slideIndex: getCurrentSlideIndex(),
    trigger: "text_change",
  };
}

// --- Send to background ---

function sendPayload(payload: ContentPayload): void {
  if (postFinished) return;
  const textPreview = payload.description?.slice(0, 50) || "(no caption)";
  console.log(`[Roam] Sending (${payload.trigger}): ${textPreview}`);
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
    // Flush dwell for previous post before switching
    engagement.flushDwell();

    // Detect scroll-back (returning to a post we already saw)
    if (seenPostIds.has(newPostId)) {
      engagement.trackRewatch(newPostId);
      engagement.trackScrollBack(newPostId);
    }
    seenPostIds.add(newPostId);

    currentPostId = newPostId;
    lastSentKey = "";
    lastSlideIndex = -1;
    localSlideCounter = 0;
    postFinished = false;
    console.log("[Roam] New post detected:", newPostId.slice(0, 30));

    // Start dwell tracking for this post
    engagement.startDwell(newPostId);

    // Detach previous video listener
    if (currentVideo) {
      currentVideo.removeEventListener("ended", onVideoEnded);
      currentVideo = null;
    }

    // Stop previous video tick
    stopVideoTick();

    // Extract text and send
    handleTextChange();

    // Attach ended listener, start tick, and watch sound if video
    const video = document.querySelector("video");
    if (video) {
      currentVideo = video;
      video.addEventListener("ended", onVideoEnded);
      startVideoTickIfNeeded();
      watchVideo(video, newPostId);
    }
  }
}

// --- Text change (debounced) ---

function handleTextChange(): void {
  const payload = extractContent();
  // Always send on post change — screenshot is the primary signal.
  // Use the text as a dedup key only when no screenshot will be taken
  // (slideIndex > 0 with no screenshot is handled in background.ts).
  const textKey = payload.description + payload.hashtags.join(",");

  if (textDebounceTimer) clearTimeout(textDebounceTimer);

  textDebounceTimer = setTimeout(() => {
    if (textKey === lastSentKey && payload.trigger === "text_change" && payload.slideIndex > 0) return;
    lastSentKey = textKey;
    sendPayload(payload);
  }, TEXT_DEBOUNCE_MS);
}

// --- Slide / carousel detection ---

function getCurrentSlideIndex(): number {
  if (isTikTok()) {
    const activeIndicator = document.querySelector(
      '[class*="SlideIndicator"] [class*="active"], [class*="DivDotItem"][class*="active"]'
    );
    if (activeIndicator?.parentElement) {
      return Array.from(activeIndicator.parentElement.children).indexOf(activeIndicator);
    }
    const counter = document.querySelector('[class*="SlideCount"], [class*="ImageCount"]');
    if (counter) {
      const match = counter.textContent?.match(/(\d+)\s*[/\/]\s*\d+/);
      if (match) return parseInt(match[1], 10);
    }
  }
  if (isInstagram()) {
    const dots = document.querySelectorAll('[class*="CarouselIndicator"] div, [role="tablist"] [role="tab"]');
    for (let i = 0; i < dots.length; i++) {
      if (dots[i].getAttribute("aria-selected") === "true" ||
          dots[i].classList.toString().includes("active")) {
        return i;
      }
    }
  }
  // Fallback: use local counter (incremented on each carousel nav click)
  return localSlideCounter;
}

function handleSlideChange(): void {
  const slideIdx = getCurrentSlideIndex();
  if (slideIdx === lastSlideIndex) return;
  lastSlideIndex = slideIdx;

  if (slideDebounceTimer) clearTimeout(slideDebounceTimer);

  slideDebounceTimer = setTimeout(() => {
    const payload = extractContent();
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
  // Find the nearest parent button first (clicks land on <path>/<svg> inside buttons)
  const parentBtn = target.closest("button");

  const isNavClick =
    // Generic aria-label patterns on buttons
    target.closest("button[aria-label*='next' i]") ??
    target.closest("button[aria-label*='previous' i]") ??
    target.closest("button[aria-label*='Go to slide' i]") ??
    target.closest("button[aria-label*='Go Back' i]") ??
    target.closest("button[aria-label*='Next' i]") ??
    // Instagram: the aria-label is on the SVG inside the button, not the button itself
    (parentBtn?.querySelector('svg[aria-label="Next"], svg[aria-label="Go Back"]') ? parentBtn : null) ??
    // Instagram: chevron buttons inside carousel posts
    target.closest("article button[aria-label]") ??
    // TikTok selectors
    target.closest('[class*="Arrow"]') ??
    target.closest('[class*="SlideNav"]') ??
    target.closest('[class*="carousel" i] button') ??
    target.closest('[data-e2e*="arrow"]');

  if (isNavClick) {
    // Flush dwell for the current slide
    engagement.flushDwell();

    // Increment slide counter before the new slide loads
    localSlideCounter++;

    // Wait for the slide to animate, then send a one-off slide_change
    setTimeout(() => {
      // Restart dwell for the new slide
      if (currentPostId) engagement.startDwell(currentPostId);

      const payload = extractContent();
      payload.trigger = "slide_change";
      console.log(`[Roam] Carousel nav → slide ${localSlideCounter}`);
      sendPayload(payload);
    }, 500);
  }
}, true);

// --- V3: Engagement Tracker ---

interface EngagementMsg {
  type: "ENGAGEMENT_EVENT";
  eventType: string;
  duration?: number;
  postId: string;
  slideIndex: number;
  platform: "instagram" | "tiktok";
  timestamp: number;
}

function sendEngagement(msg: EngagementMsg): void {
  try {
    chrome.runtime.sendMessage(msg).catch(() => {});
  } catch {
    // Extension context invalidated
  }
}

function getPlatform(): "instagram" | "tiktok" {
  return isTikTok() ? "tiktok" : "instagram";
}

function engagementKey(): string {
  return `${currentPostId}:${getCurrentSlideIndex()}`;
}

const engagement = {
  dwellStart: 0,
  trackedPostId: "",
  trackedSlideIndex: 0,
  rewatchedKeys: new Set<string>(),
  soundTrackedKeys: new Set<string>(),

  startDwell(postId: string): void {
    this.flushDwell();
    this.trackedPostId = postId;
    this.trackedSlideIndex = getCurrentSlideIndex();
    this.dwellStart = Date.now();
  },

  flushDwell(): void {
    if (this.dwellStart && this.trackedPostId) {
      const rawDuration = Date.now() - this.dwellStart;

      // AFK check: if user has been inactive for > AFK_THRESHOLD_MS, strip the
      // idle tail. Effective dwell = time from start until they last moved.
      const idleMs = Date.now() - lastActivityTime;
      const effectiveDuration = idleMs > AFK_THRESHOLD_MS
        ? Math.max(0, lastActivityTime - this.dwellStart)
        : rawDuration;

      if (effectiveDuration > 1500) {
        sendEngagement({
          type: "ENGAGEMENT_EVENT",
          eventType: "dwell",
          duration: effectiveDuration,
          postId: this.trackedPostId,
          slideIndex: this.trackedSlideIndex,
          platform: getPlatform(),
          timestamp: Date.now(),
        });
        const tag = idleMs > AFK_THRESHOLD_MS
          ? `${Math.round(effectiveDuration / 1000)}s active (AFK-trimmed from ${Math.round(rawDuration / 1000)}s)`
          : `${Math.round(effectiveDuration / 1000)}s`;
        console.log(`[Roam] Dwell: ${tag} on ${this.trackedPostId.slice(0, 20)}:${this.trackedSlideIndex}`);
      } else if (idleMs > AFK_THRESHOLD_MS) {
        console.log(`[Roam] Dwell discarded — AFK for ${Math.round(idleMs / 1000)}s, active time < 1.5s`);
      }
      this.dwellStart = 0;
    }
  },

  trackRewatch(postId: string): void {
    const key = engagementKey();
    if (this.rewatchedKeys.has(key)) return;
    this.rewatchedKeys.add(key);
    sendEngagement({
      type: "ENGAGEMENT_EVENT",
      eventType: "rewatch",
      postId,
      slideIndex: getCurrentSlideIndex(),
      platform: getPlatform(),
      timestamp: Date.now(),
    });
    console.log("[Roam] Rewatch:", key);
  },

  trackSoundOn(postId: string): void {
    const key = engagementKey();
    if (this.soundTrackedKeys.has(key)) return;
    this.soundTrackedKeys.add(key);
    sendEngagement({
      type: "ENGAGEMENT_EVENT",
      eventType: "sound_on",
      postId,
      slideIndex: getCurrentSlideIndex(),
      platform: getPlatform(),
      timestamp: Date.now(),
    });
    console.log("[Roam] Sound on:", key);
  },

  trackProfileClick(postId: string): void {
    sendEngagement({
      type: "ENGAGEMENT_EVENT",
      eventType: "profile_click",
      postId,
      slideIndex: getCurrentSlideIndex(),
      platform: getPlatform(),
      timestamp: Date.now(),
    });
    console.log("[Roam] Profile click:", engagementKey());
  },

  trackHashtagClick(postId: string): void {
    sendEngagement({
      type: "ENGAGEMENT_EVENT",
      eventType: "hashtag_click",
      postId,
      slideIndex: getCurrentSlideIndex(),
      platform: getPlatform(),
      timestamp: Date.now(),
    });
    console.log("[Roam] Hashtag click:", engagementKey());
  },

  trackScrollBack(postId: string): void {
    sendEngagement({
      type: "ENGAGEMENT_EVENT",
      eventType: "scroll_back",
      postId,
      slideIndex: getCurrentSlideIndex(),
      platform: getPlatform(),
      timestamp: Date.now(),
    });
    console.log("[Roam] Scroll back:", engagementKey());
  },
};

// Track rewatch: if we navigate back to a post we already saw
const seenPostIds = new Set<string>();

// Sound + pause detection — watch for volume/mute and pause on video elements
function watchVideo(video: HTMLVideoElement, postId: string): void {
  video.addEventListener("volumechange", () => {
    if (!video.muted) engagement.trackSoundOn(postId);
  });
  // User-initiated pause (not programmatic)
  let wasPlaying = !video.paused;
  video.addEventListener("pause", () => {
    if (wasPlaying && !video.ended) {
      sendEngagement({
        type: "ENGAGEMENT_EVENT",
        eventType: "video_pause",
        postId,
        slideIndex: getCurrentSlideIndex(),
        platform: getPlatform(),
        timestamp: Date.now(),
      });
      console.log("[Roam] Video pause:", engagementKey());
    }
  });
  video.addEventListener("play", () => { wasPlaying = true; });
}

// Helper: emit an engagement event for the current post+slide
function emitEngagement(eventType: string): void {
  sendEngagement({
    type: "ENGAGEMENT_EVENT",
    eventType,
    postId: currentPostId,
    slideIndex: getCurrentSlideIndex(),
    platform: getPlatform(),
    timestamp: Date.now(),
  });
  console.log(`[Roam] ${eventType}:`, engagementKey());
}

// Helper: check if the clicked element (or its parent button) contains an SVG with a matching aria-label
function clickedSvgLabel(target: HTMLElement, ...labels: string[]): boolean {
  // Check if the target itself or an ancestor is/contains a matching SVG
  for (const label of labels) {
    // Direct match: clicked on the SVG or its children
    if (target.closest(`svg[aria-label="${label}"]`)) return true;
    // Parent button contains a matching SVG
    const btn = target.closest("button");
    if (btn?.querySelector(`svg[aria-label="${label}"]`)) return true;
    // Also check span/div wrappers (TikTok)
    const wrapper = target.closest('[role="button"]');
    if (wrapper?.querySelector(`svg[aria-label="${label}"]`)) return true;
  }
  return false;
}

// Engagement click detection
document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (!currentPostId) return;

  // --- Like ---
  if (clickedSvgLabel(target, "Like", "Unlike", "like", "unlike")) {
    emitEngagement("like");
  }

  // --- Save/bookmark ---
  if (clickedSvgLabel(target, "Save", "Remove", "Unsave", "save", "Favorites", "Add to Favorites", "Remove from Favorites")) {
    emitEngagement("save_click");
  }

  // --- Share ---
  if (clickedSvgLabel(target, "Share Post", "Share", "share", "Send Message", "Direct")) {
    emitEngagement("share_click");
  }

  // --- Comment ---
  if (clickedSvgLabel(target, "Comment", "comment", "View comments")) {
    emitEngagement("comment_open");
  }

  // --- Profile clicks ---
  const profileLink =
    target.closest("a[href*='/profile/']") ??         // TikTok
    target.closest('a[href^="/"]:not([href*="/p/"]):not([href*="/reel/"])'); // Instagram
  if (profileLink) {
    const href = (profileLink as HTMLAnchorElement).href ?? "";
    if (href.match(/\/@[\w.]+\/?$/) || (isInstagram() && href.match(/\/[\w.]+\/?$/))) {
      engagement.trackProfileClick(currentPostId);
    }
  }

  // --- Hashtag clicks ---
  const hashtagLink =
    target.closest("a[href*='/tag/']") ??
    target.closest("a[href*='/explore/tags/']");
  if (hashtagLink) {
    engagement.trackHashtagClick(currentPostId);
  }

  // --- Caption expand ("more" / "...more") ---
  const expandBtn = target.closest('[role="button"]');
  if (expandBtn) {
    const text = expandBtn.textContent?.trim().toLowerCase() ?? "";
    if (text === "more" || text === "...more" || text === "... more") {
      emitEngagement("caption_expand");
    }
  }

  // --- TikTok fallbacks using data-e2e attributes ---
  if (isTikTok()) {
    if (target.closest('[data-e2e*="like"]')) emitEngagement("like");
    if (target.closest('[data-e2e*="favorite"], [data-e2e*="collect"]')) emitEngagement("save_click");
    if (target.closest('[data-e2e*="share"]')) emitEngagement("share_click");
    if (target.closest('[data-e2e*="comment"]')) emitEngagement("comment_open");
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

// Flush dwell on page unload
document.addEventListener("visibilitychange", () => {
  if (document.hidden) engagement.flushDwell();
});

// --- Init ---
console.log("[Roam] Content script loaded on", location.hostname);
handlePostChange();
