export const CONFIG = {
  BACKEND_URL: "http://localhost:3000",
  // Engagement Scoring Points & Multipliers
  SCORING: {
    WEIGHTS: {
      dwell: 0.5,
      rewatch: 25,
      sound_on: 12,
      profile_click: 30,
      hashtag_click: 20,
      scroll_back: 18,
      save_click: 35,
      share_click: 30,
      comment_open: 15,
      caption_expand: 10,
      video_pause: 8,
      like: 20,
    } as Record<string, number>,
    MULTI_POST_BONUS: 10,
    DECAY_HALF_LIFE_MS: 7 * 24 * 60 * 60 * 1000,
    DWELL: {
      THRESHOLDS_SEC: { FIRST: 5, SECOND: 15, THIRD: 30 },
      MULTIPLIERS: { BASE: 1, SECOND: 1.5, THIRD: 2, FOURTH: 3 }
    }
  },

  // Flight Polling Limits (background.ts)
  POLLING: {
    BASE_MAX_POLLS: 5,
    CEILING_MAX_POLLS: 20,
    DWELL_MS_PER_EXTRA_POLL: 5000,
    INTERVAL_MS: 2000,
  },

  // Content Script Thresholds & Debouncing
  CONTENT: {
    TEXT_DEBOUNCE_MS: 800,
    VIDEO_TICK_MS: 1000,
    SLIDE_DEBOUNCE_MS: 400,
    AFK_THRESHOLD_MS: 20000,
    MIN_EFFECTIVE_DWELL_MS: 1500,
  },

  // Processing Limits (background.ts)
  LIMITS: {
    MAX_DESTINATIONS_PER_SLIDE: 15, // Skip processing if more than this (list posts)
  },

  // LLM Settings (popup.ts / background.ts)
  GEMINI: {
    NARRATOR_MODEL: "gemma-3-27b-it",
    MAX_OUTPUT_TOKENS: 256,
    TEMPERATURE: 1.0,
  }
};
