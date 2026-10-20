import { getDb } from "./db";

export interface Settings {
  reminders: {
    /** "tonight's dinner" heads-up on cooking nights with a meal planned */
    dinner: boolean;
    /** HH:MM, household time zone */
    dinnerTime: string;
    /** the evening before, when tomorrow's recipe needs thawing, marinating, or soaking */
    prep: boolean;
    /** Sunday morning nudge when next week has nothing planned */
    sunday: boolean;
  };
  /** read Sal's replies out loud: never, after you send a voice note, or always */
  readAloud: "off" | "voice" | "always";
}

export const DEFAULT_SETTINGS: Settings = {
  reminders: { dinner: true, dinnerTime: "16:00", prep: true, sunday: true },
  readAloud: "voice",
};

export function getSettings(userId: number): Settings {
  const r = getDb().prepare("select settings from user_settings where user_id = ?").get(userId) as { settings: string } | undefined;
  const saved = r ? (JSON.parse(r.settings) as Partial<Settings>) : {};
  return { ...DEFAULT_SETTINGS, ...saved, reminders: { ...DEFAULT_SETTINGS.reminders, ...saved.reminders } };
}

/** Merge a partial change in, keeping only known keys with the right types. */
export function updateSettings(userId: number, change: unknown): Settings {
  const cur = getSettings(userId);
  const c = (change ?? {}) as Record<string, unknown>;
  const r = (c.reminders ?? {}) as Record<string, unknown>;
  const next: Settings = {
    readAloud: c.readAloud === "off" || c.readAloud === "voice" || c.readAloud === "always" ? c.readAloud : cur.readAloud,
    reminders: {
      dinner: typeof r.dinner === "boolean" ? r.dinner : cur.reminders.dinner,
      dinnerTime: typeof r.dinnerTime === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(r.dinnerTime) ? r.dinnerTime : cur.reminders.dinnerTime,
      prep: typeof r.prep === "boolean" ? r.prep : cur.reminders.prep,
      sunday: typeof r.sunday === "boolean" ? r.sunday : cur.reminders.sunday,
    },
  };
  getDb()
    .prepare("insert into user_settings (user_id, settings) values (?, ?) on conflict(user_id) do update set settings = excluded.settings")
    .run(userId, JSON.stringify(next));
  return next;
}
