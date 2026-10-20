import { busyEvenings } from "./calendar";
import { getDb } from "./db";
import { addDays, localDate, weekday, weekStart } from "./dates";
import { createDinner, deleteMealPlan, getRecipe, searchRecipes } from "./mealie";

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
}

export interface Week {
  start: string;
  end: string;
  nights: Night[];
  calendar: { configured: boolean; error?: string };
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
};

export async function getWeek(start = weekStart(localDate())): Promise<Week> {
  start = weekStart(start);
  const end = addDays(start, 6);
  const rows = getDb().prepare("select * from nights where date between ? and ?").all(start, end) as NightRow[];
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
      sentToMealie: Boolean(r?.mealie_entry_id),
    });
  }
  return { start, end, nights, calendar: { configured: cal.configured, error: cal.error } };
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

/** Write every cooking night that has a meal to Mealie as a dinner, replacing what this app sent before. */
export async function sendWeekToMealie(start: string): Promise<{ sent: number; skipped: string[] }> {
  const week = await getWeek(start);
  const d = getDb();
  let sent = 0;
  const skipped: string[] = [];
  for (const n of week.nights) {
    const row = d.prepare("select mealie_entry_id from nights where date = ?").get(n.date) as { mealie_entry_id: string | null } | undefined;
    if (row?.mealie_entry_id) {
      await deleteMealPlan(row.mealie_entry_id);
      d.prepare("update nights set mealie_entry_id = null where date = ?").run(n.date);
    }
    if (!n.cooking || !n.title) {
      if (n.cooking) skipped.push(n.day);
      continue;
    }
    const text = [n.note, n.sourceUrl && !n.recipeId ? `Recipe: ${n.sourceUrl}` : null].filter(Boolean).join("\n");
    const entry = await createDinner({ date: n.date, title: n.recipeId ? "" : n.title, text, recipeId: n.recipeId });
    d.prepare("update nights set mealie_entry_id = ? where date = ?").run(String(entry.id), n.date);
    sent++;
  }
  return { sent, skipped };
}
