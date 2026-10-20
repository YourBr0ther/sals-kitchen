import { config } from "./config";
import { getDb } from "./db";
import { addDays, localDate, weekStart, zonedTime } from "./dates";
import { getRecipe } from "./mealie";
import { pushConfigured, sendToUser, usersWithSubscriptions, type PushMessage } from "./push";
import { getSettings } from "./settings";
import { getWeek, type Week } from "./week";

export type ReminderKind = "dinner" | "prep" | "sunday";

/** A reminder missed by a restart or a slow minute still goes out this long after its time, and never later. */
export const CATCH_UP_MS = 30 * 60_000;
const TICK_MS = 60_000;
const PREP_HOUR = 20;
const SUNDAY_HOUR = 10;

/** The instant of HH:MM on `date` in the household's time zone. */
export function reminderTime(date: string, hhmm: string, tz = config.tz): Date {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(zonedTime(date, h, tz).getTime() + m * 60_000);
}

/** Due from its time until CATCH_UP_MS later. */
export const isDue = (at: Date, now: Date) => now.getTime() >= at.getTime() && now.getTime() - at.getTime() < CATCH_UP_MS;

// Each rule reads one sentence. A soak or marinade timed in minutes (or one hour) happens on the
// day, so it doesn't count; one with no time given, hours, or "overnight" does.
const OVERNIGHT = /\bovernight\b/i;
const HOURS = /\b(\d+)(?:\s*(?:-|to)\s*(\d+))?\s*(?:hours?|hrs?)\b/i;
const MINUTES = /\b\d+\s*(?:minutes?|mins?)\b|\b(?:an|one|1)\s*hour\b/i;
// frozen peas and the like thaw in minutes, so a line about them doesn't count
const QUICK_FROZEN = /\bfrozen\s+(?:peas|corn|spinach|berries|blueberries|raspberries|strawberries|fruit|mango|vegetables|veggies|edamame|broccoli|green beans|mixed)\b/i;

const longEnough = (s: string) => {
  if (OVERNIGHT.test(s)) return true;
  const h = s.match(HOURS);
  if (h) return Number(h[2] ?? h[1]) >= 2;
  return !MINUTES.test(s);
};

type Rule = { test: RegExp; needs: (overnight: boolean) => string; timed: boolean; unless?: RegExp };

const RULES: Rule[] = [
  { test: /\b(?:thaw(?:ed|ing)?|defrost(?:ed|ing)?|frozen)\b/i, unless: QUICK_FROZEN, needs: () => "to thaw overnight", timed: false },
  { test: /\bmarinat(?:e|ed|es|ing)\b|\bmarinade\b/i, needs: (o) => (o ? "to marinate overnight" : "time to marinate"), timed: true },
  { test: /\bbrin(?:e|ed|ing)\b/i, needs: (o) => (o ? "to brine overnight" : "time in the brine"), timed: true },
  { test: /\bsoak(?:ed|ing|s)?\b(?!\s+up)/i, needs: (o) => (o ? "to soak overnight" : "a soak first"), timed: true },
  {
    test: /\b(?:long|slow)\s+(?:rise|proof|ferment)|\bcold[- ]ferment|\b(?:rise|proof|ferment)\w*\b.*\b(?:overnight|(?:[6-9]|[1-9]\d)\s*(?:hours?|hrs?))\b/i,
    needs: () => "a long rise",
    timed: false,
  },
  { test: OVERNIGHT, needs: () => "to start tonight", timed: false },
];

/**
 * What a recipe needs started the evening before, from its ingredients and steps, finishing
 * the sentence "Tomorrow's X needs ___." Null when nothing does.
 */
export function prepNeed(lines: string[]): string | null {
  const sentences = lines.flatMap((l) => l.split(/(?<=[.!?;])\s+/)).filter(Boolean);
  for (const rule of RULES) {
    const hits = sentences.filter((s) => rule.test.test(s) && !rule.unless?.test(s));
    const counted = rule.timed ? hits.filter(longEnough) : hits;
    if (counted.length) return rule.needs(counted.some((s) => OVERNIGHT.test(s)));
  }
  return null;
}

/** Record the send first, so a restart or a second pod can't send it again. False if it already went. */
function claim(userId: number, kind: ReminderKind, day: string): boolean {
  return getDb().prepare("insert or ignore into notifications_sent (user_id, kind, day) values (?, ?, ?)").run(userId, kind, day).changes === 1;
}

type Recipe = { ingredients: string[]; steps: string[]; totalTime: string | null };

export interface Deps {
  send: (userId: number, msg: PushMessage) => Promise<unknown>;
  recipe: (slug: string) => Promise<Recipe>;
  week: (start: string) => Promise<Week>;
}

const defaultDeps: Deps = { send: sendToUser, recipe: getRecipe, week: getWeek };

/** Check every reminder for every person with a phone signed up, as of `now`. Never throws. */
export async function runOnce(now = new Date(), deps: Deps = defaultDeps): Promise<{ userId: number; kind: ReminderKind; day: string }[]> {
  const sent: { userId: number; kind: ReminderKind; day: string }[] = [];
  // tests pass their own sender, so they run without keys
  if (deps.send === sendToUser && !pushConfigured()) return sent;

  // read each week and recipe at most once per run, and only when a reminder is due
  const weeks = new Map<string, Promise<Week>>();
  const weekOf = (date: string) => {
    const start = weekStart(date);
    if (!weeks.has(start)) weeks.set(start, deps.week(start));
    return weeks.get(start)!;
  };
  const nightOn = async (date: string) => (await weekOf(date)).nights.find((n) => n.date === date);
  const recipes = new Map<string, Promise<Recipe | null>>();
  const recipeOf = (slug: string) => {
    if (!recipes.has(slug)) {
      recipes.set(
        slug,
        deps.recipe(slug).catch((e) => {
          console.warn(`[reminders] couldn't read ${slug} from Mealie:`, e instanceof Error ? e.message : e);
          return null;
        }),
      );
    }
    return recipes.get(slug)!;
  };

  const today = localDate(now);
  const tomorrow = addDays(today, 1);
  const isSunday = new Date(`${today}T12:00:00Z`).getUTCDay() === 0;

  for (const userId of usersWithSubscriptions()) {
    try {
      const { reminders: r } = getSettings(userId);
      const go = async (kind: ReminderKind, day: string, msg: PushMessage) => {
        if (!claim(userId, kind, day)) return;
        await deps.send(userId, msg);
        sent.push({ userId, kind, day });
      };

      if (r.dinner && isDue(reminderTime(today, r.dinnerTime), now)) {
        const n = await nightOn(today);
        if (n?.cooking && n.title) {
          const recipe = n.recipeSlug ? await recipeOf(n.recipeSlug) : null;
          await go("dinner", today, {
            title: `Tonight: ${n.title}`,
            body: recipe?.totalTime ? `Takes about ${recipe.totalTime}.` : "It's on the week ticket.",
            url: "/?tab=week",
            tag: `dinner-${today}`,
          });
        }
      }

      if (r.prep && isDue(reminderTime(today, `${PREP_HOUR}:00`), now)) {
        const n = await nightOn(tomorrow);
        if (n?.cooking && n.title && n.recipeSlug) {
          const recipe = await recipeOf(n.recipeSlug);
          const needs = recipe && prepNeed([...recipe.ingredients, ...recipe.steps]);
          if (needs) {
            await go("prep", tomorrow, {
              title: "Prep tonight",
              body: `Tomorrow's ${n.title} needs ${needs}.`,
              url: "/?tab=week",
              tag: `prep-${tomorrow}`,
            });
          }
        }
      }

      if (r.sunday && isSunday && isDue(reminderTime(today, `${SUNDAY_HOUR}:00`), now)) {
        // the next week that hasn't started yet: weeks run Monday to Sunday, so it's the one after today
        const next = addDays(weekStart(today), 7);
        const planned = (await weekOf(next)).nights.filter((n) => n.cooking && n.title).length;
        if (planned < 2) {
          await go("sunday", today, {
            title: "Next week's ticket is empty",
            body: "Want Sal to plan it?",
            url: "/?tab=chat",
            tag: `sunday-${today}`,
          });
        }
      }
    } catch (e) {
      console.error(`[reminders] user ${userId}:`, e);
    }
  }
  return sent;
}

declare global {
  var __salReminders: ReturnType<typeof setInterval> | undefined;
}

/** Start the once-a-minute check. Safe to call again; dev reloads reuse the running timer. */
export function startReminders() {
  if (globalThis.__salReminders) return;
  if (!pushConfigured()) {
    console.log("[reminders] VAPID keys aren't set, so reminders are off");
    return;
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runOnce();
    } catch (e) {
      console.error("[reminders]", e);
    } finally {
      running = false;
    }
  };
  globalThis.__salReminders = setInterval(tick, TICK_MS);
  globalThis.__salReminders.unref?.();
  void tick();
  console.log("[reminders] started");
}
