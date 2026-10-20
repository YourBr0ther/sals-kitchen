import { busyEvenings } from "./calendar";
import { getDb } from "./db";
import { addDays, localDate, weekday, weekStart } from "./dates";
import { createDinner, deleteMealPlan, getRecipe, searchRecipes, shoppingListUrl } from "./mealie";

export interface Night {
  date: string;
  day: string;
  busy: string[];
  /** null means "follow the calendar" */
  override: boolean | null;
  cooking: boolean;
  title: string | null;
  recipeSlug: string | null;
  recipeId: string | null;
  sourceUrl: string | null;
  note: string | null;
  sentToMealie: boolean;
  /** who last changed this night */
  plannedBy: string | null;
  /** how it went, once people say */
  feedback: { name: string; verdict: string }[];
}

export interface Week {
  start: string;
  end: string;
  nights: Night[];
  calendar: { configured: boolean; error?: string };
  /** the Mealie grocery list made for this week, if any */
  groceries: { url: string; count: number; updatedAt: string } | null;
}

type NightRow = {
  date: string;
  cooking: number | null;
  title: string | null;
  recipe_slug: string | null;
  recipe_id: string | null;
  source_url: string | null;
  note: string | null;
  mealie_entry_id: string | null;
  sent_signature: string | null;
  updated_by: number | null;
};

/** What a night looked like when it went to Mealie; if it changes, the ticket stops saying "in Mealie". */
export const signature = (r: Pick<NightRow, "title" | "recipe_id" | "source_url" | "note">) =>
  JSON.stringify([r.title ?? "", r.recipe_id ?? "", r.source_url ?? "", r.note ?? ""]);

export async function getWeek(start = weekStart(localDate())): Promise<Week> {
  start = weekStart(start);
  const end = addDays(start, 6);
  const d = getDb();
  const rows = d.prepare("select * from nights where date between ? and ?").all(start, end) as NightRow[];
  const names = new Map((d.prepare("select id, name from users").all() as { id: number; name: string }[]).map((u) => [u.id, u.name]));
  const fb = d
    .prepare("select date, user_id, verdict from feedback where date between ? and ? and verdict != 'dismissed' order by user_id")
    .all(start, end) as { date: string; user_id: number; verdict: string }[];
  const list = d.prepare("select list_id, item_count, updated_at from grocery_lists where week_start = ?").get(start) as
    | { list_id: string; item_count: number; updated_at: string }
    | undefined;
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const cal = await busyEvenings(start, 7);
  const busyByDate = new Map(cal.busy.map((b) => [b.date, b.reasons]));

  const nights: Night[] = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(start, i);
    const r = byDate.get(date);
    const busy = busyByDate.get(date) ?? [];
    const override = r?.cooking == null ? null : r.cooking === 1;
    nights.push({
      date,
      day: weekday(date),
      busy,
      override,
      cooking: override ?? busy.length === 0,
      title: r?.title ?? null,
      recipeSlug: r?.recipe_slug ?? null,
      recipeId: r?.recipe_id ?? null,
      sourceUrl: r?.source_url ?? null,
      note: r?.note ?? null,
      sentToMealie: Boolean(r?.mealie_entry_id && override !== false && (override ?? busy.length === 0) && r.sent_signature === signature(r)),
      plannedBy: r?.updated_by ? (names.get(r.updated_by) ?? null) : null,
      feedback: fb.filter((f) => f.date === date).map((f) => ({ name: names.get(f.user_id) ?? "Someone", verdict: f.verdict })),
    });
  }
  return {
    start,
    end,
    nights,
    calendar: { configured: cal.configured, error: cal.error },
    groceries: list ? { url: shoppingListUrl(list.list_id), count: list.item_count, updatedAt: list.updated_at } : null,
  };
}

async function findByName(title: string) {
  const name = title.replace(/\s*\(.*?\)\s*/g, " ").trim().toLowerCase();
  const { recipes } = await searchRecipes(name, 5);
  return recipes.find((r) => r.name.toLowerCase() === name);
}

export interface NightUpdate {
  date: string;
  cooking?: boolean | null;
  title?: string | null;
  recipeSlug?: string | null;
  sourceUrl?: string | null;
  note?: string | null;
}

export async function updateNight(u: NightUpdate, byUserId: number) {
  const d = getDb();
  const existing = d.prepare("select * from nights where date = ?").get(u.date) as NightRow | undefined;
  const next = {
    cooking: existing?.cooking ?? null,
    title: existing?.title ?? null,
    recipe_slug: existing?.recipe_slug ?? null,
    recipe_id: existing?.recipe_id ?? null,
    source_url: existing?.source_url ?? null,
    note: existing?.note ?? null,
  };
  if (u.cooking !== undefined) next.cooking = u.cooking === null ? null : u.cooking ? 1 : 0;
  if (u.title !== undefined) next.title = u.title?.trim() || null;
  if (u.note !== undefined) next.note = u.note?.trim() || null;
  if (u.sourceUrl !== undefined) next.source_url = u.sourceUrl || null;
  if (u.recipeSlug !== undefined) {
    next.recipe_slug = u.recipeSlug || null;
    next.recipe_id = null;
    if (u.recipeSlug) {
      // resolve now so a typo'd slug fails here, not at send time
      const r = await getRecipe(u.recipeSlug);
      next.recipe_slug = r.slug;
      next.recipe_id = r.id;
      if (u.title === undefined || !u.title) next.title = r.name;
    }
  } else if (u.title !== undefined) {
    // a new free-text meal replaces whatever recipe was linked, unless the box has a recipe by that exact name
    next.recipe_slug = null;
    next.recipe_id = null;
    if (u.title && !u.sourceUrl) {
      const match = await findByName(u.title).catch(() => undefined);
      if (match) {
        next.recipe_slug = match.slug;
        next.recipe_id = match.id;
      }
    }
  }
  d.prepare(
    `insert into nights (date, cooking, title, recipe_slug, recipe_id, source_url, note, updated_by, updated_at)
     values (@date, @cooking, @title, @recipe_slug, @recipe_id, @source_url, @note, @by, datetime('now'))
     on conflict(date) do update set cooking = excluded.cooking, title = excluded.title,
       recipe_slug = excluded.recipe_slug, recipe_id = excluded.recipe_id, source_url = excluded.source_url,
       note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run({ date: u.date, ...next, by: byUserId });
}

let sending: Promise<unknown> = Promise.resolve();

/**
 * Write every cooking night that has a meal to Mealie as a dinner, replacing what this app
 * sent before. Sends run one at a time, so two people tapping at once can't duplicate dinners.
 */
export function sendWeekToMealie(start: string): Promise<{ sent: number; skipped: string[] }> {
  const run = sending.then(() => sendNow(start));
  sending = run.catch(() => {});
  return run;
}

async function sendNow(start: string): Promise<{ sent: number; skipped: string[] }> {
  const week = await getWeek(start);
  const d = getDb();
  let sent = 0;
  const skipped: string[] = [];
  for (const n of week.nights) {
    const row = d.prepare("select * from nights where date = ?").get(n.date) as NightRow | undefined;
    if (row?.mealie_entry_id) {
      await deleteMealPlan(row.mealie_entry_id);
      d.prepare("update nights set mealie_entry_id = null, sent_signature = null where date = ?").run(n.date);
    }
    // read the night fresh: someone may have changed it while earlier nights were sending
    const now = d.prepare("select * from nights where date = ?").get(n.date) as NightRow | undefined;
    const cooking = now?.cooking == null ? n.busy.length === 0 : now.cooking === 1;
    if (!cooking || !now?.title) {
      if (cooking) skipped.push(n.day);
      continue;
    }
    const text = [now.note, now.source_url && !now.recipe_id ? `Recipe: ${now.source_url}` : null].filter(Boolean).join("\n");
    const entry = await createDinner({ date: n.date, title: now.recipe_id ? "" : now.title, text, recipeId: now.recipe_id });
    d.prepare("update nights set mealie_entry_id = ?, sent_signature = ? where date = ?").run(String(entry.id), signature(now), n.date);
    sent++;
  }
  return { sent, skipped };
}
