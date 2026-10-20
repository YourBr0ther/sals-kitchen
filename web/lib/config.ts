import path from "node:path";

function env(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

export const config = {
  llm: {
    baseURL: env("LLM_BASE_URL", "https://nano-gpt.com/api/subscription/v1"),
    apiKey: env("LLM_API_KEY"),
    model: env("LLM_MODEL", "z-ai/glm-5.3"),
    // reads photos and describes them for the chat model, which may be text-only
    visionModel: env("VISION_MODEL", "moonshotai/kimi-k2.6"),
  },
  nanogpt: {
    // root for NanoGPT's non-chat endpoints (web search, speech-to-text)
    url: env("NANOGPT_API_URL", "https://nano-gpt.com"),
    sttModel: env("STT_MODEL", "Whisper-Large-V3"),
  },
  mealie: {
    url: env("MEALIE_URL").replace(/\/$/, ""),
    token: env("MEALIE_API_TOKEN"),
    // public link for recipe pages, if the app reaches Mealie on an internal address
    publicUrl: env("MEALIE_PUBLIC_URL", env("MEALIE_URL")).replace(/\/$/, ""),
  },
  calendarUrls: env("CALENDAR_ICS_URLS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  tz: env("TZ", "America/New_York"),
  // evening window that counts as "busy" when a calendar event overlaps it
  eveningStart: Number(env("EVENING_START_HOUR", "17")),
  eveningEnd: Number(env("EVENING_END_HOUR", "20")),
  dataDir: path.resolve(/* turbopackIgnore: true */ env("DATA_DIR", "./data")),
};

export const mealieConfigured = () => Boolean(config.mealie.url && config.mealie.token);
