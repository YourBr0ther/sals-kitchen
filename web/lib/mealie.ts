import { config, mealieConfigured } from "./config";
import { type Recipe, toSchemaJson } from "./recipe";
import { fetchImage } from "./web";

export class MealieError extends Error {}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!mealieConfigured()) throw new MealieError("Mealie isn't connected. Set MEALIE_URL and MEALIE_API_TOKEN.");
  let res: Response;
  try {
    res = await fetch(`${config.mealie.url}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.mealie.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    const timedOut = (e as Error).name === "TimeoutError";
    throw new MealieError(timedOut ? "Mealie took too long to answer." : "Couldn't reach Mealie. It may be restarting; try again in a minute.");
  }
  if (res.status === 401 || res.status === 403) {
    throw new MealieError("Mealie turned down the API token. It may have been deleted or expired.");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn(`[mealie] ${init.method ?? "GET"} ${path} -> ${res.status}: ${body.slice(0, 500)}`);
    if (res.status === 404) throw new MealieError("Mealie couldn't find that recipe or plan.");
    if (res.status === 400 || res.status === 422) throw new MealieError("Mealie didn't accept that. The recipe data may be incomplete.");
    if (res.status >= 500) throw new MealieError("Mealie hit an error on its end. Try again in a minute.");
    throw new MealieError(`Mealie said no (${res.status}).`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface RecipeSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  totalTime: string | null;
  tags: string[];
  categories: string[];
  rating: number | null;
  lastMade: string | null;
  url: string;
}

type RawRecipe = {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  totalTime?: string | null;
  prepTime?: string | null;
  performTime?: string | null;
  // Mealie 3.x stores parsed durations as seconds and leaves the text fields empty
  totalTimeSeconds?: number | null;
  prepTimeSeconds?: number | null;
  performTimeSeconds?: number | null;
  tags?: { name: string }[];
  recipeCategory?: { name: string }[];
  rating?: number | null;
  lastMade?: string | null;
  recipeYield?: string | null;
  recipeServings?: number | null;
  recipeYieldQuantity?: number | null;
  orgURL?: string | null;
  recipeIngredient?: { display?: string; note?: string; originalText?: string; title?: string | null }[];
  recipeInstructions?: { text: string; title?: string | null }[];
  notes?: { title: string; text: string }[];
  nutrition?: Record<string, string | null>;
  settings?: Record<string, unknown>;
};

/** "1 hr 10 min" from seconds. */
function readableSeconds(s: number | null | undefined): string | null {
  if (!s || s <= 0) return null;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return [h && `${h} hr`, m && `${m} min`].filter(Boolean).join(" ") || null;
}

const totalTimeOf = (r: RawRecipe) =>
  r.totalTime ||
  readableSeconds(r.totalTimeSeconds) ||
  r.performTime ||
  readableSeconds(r.performTimeSeconds) ||
  r.prepTime ||
  readableSeconds(r.prepTimeSeconds) ||
  null;

// recipe pages live under the group's slug; learned on first use, "home" until then
let groupSlug = "home";
let groupSlugLoaded = false;
async function loadGroupSlug() {
  if (groupSlugLoaded) return;
  groupSlugLoaded = true;
  const me = await call<{ groupSlug?: string }>("/api/users/self").catch(() => null);
  if (me?.groupSlug) groupSlug = me.groupSlug;
}
const recipeUrl = (slug: string) => `${config.mealie.publicUrl}/g/${groupSlug}/r/${encodeURIComponent(slug)}`;

function summarize(r: RawRecipe): RecipeSummary {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: (r.description ?? "").slice(0, 240),
    totalTime: totalTimeOf(r),
    tags: (r.tags ?? []).map((t) => t.name),
    categories: (r.recipeCategory ?? []).map((c) => c.name),
    rating: r.rating ?? null,
    lastMade: r.lastMade ?? null,
    url: recipeUrl(r.slug),
  };
}

export async function searchRecipes(query: string, perPage = 12): Promise<{ total: number; recipes: RecipeSummary[] }> {
  await loadGroupSlug();
  const params = new URLSearchParams({ perPage: String(perPage), page: "1", orderBy: "name", orderDirection: "asc" });
  if (query.trim()) params.set("search", query.trim());
  const data = await call<{ total: number; items: RawRecipe[] }>(`/api/recipes?${params}`);
  return { total: data.total, recipes: data.items.map(summarize) };
}

export async function getRecipe(slug: string) {
  await loadGroupSlug();
  const r = await call<RawRecipe>(`/api/recipes/${encodeURIComponent(slug)}`);
  const makes = [r.recipeYieldQuantity || "", r.recipeYield ?? ""].join(" ").trim();
  return {
    ...summarize(r),
    servings: [r.recipeServings ? `${r.recipeServings} servings` : "", makes].filter(Boolean).join(", ") || null,
    source: r.orgURL ?? null,
    // section headings go in as their own lines, so "For the sauce:" reads in place
    ingredients: (r.recipeIngredient ?? []).flatMap((i) => {
      const line = i.display || i.originalText || i.note || "";
      return [i.title ? `${i.title}:` : "", line].filter(Boolean);
    }),
    steps: (r.recipeInstructions ?? []).map((s) => (s.title ? `[${s.title}] ${s.text}` : s.text)),
    notes: (r.notes ?? []).map((n) => `${n.title}: ${n.text}`),
  };
}

/**
 * What Mealie's import loses, set exactly once the recipe exists: the source link,
 * ingredient section headings, servings next to "makes 1 loaf", and showing nutrition.
 */
function afterImport(recipe: Recipe, saved: RawRecipe): Record<string, unknown> {
  const patch: Record<string, unknown> = { orgURL: recipe.sourceUrl };
  const ingredients = saved.recipeIngredient ?? [];
  // only when Mealie kept every line, so a heading can't land on the wrong one
  if (recipe.ingredientHeadings?.length && ingredients.length === recipe.recipeIngredient.length) {
    const titles = new Map(recipe.ingredientHeadings.map((h) => [h.at, h.title]));
    patch.recipeIngredient = ingredients.map((ing, i) => (titles.has(i) ? { ...ing, title: titles.get(i) } : ing));
  }
  if (recipe.servings) patch.recipeServings = recipe.servings;
  if (recipe.makes) {
    patch.recipeYieldQuantity = recipe.makes.quantity;
    patch.recipeYield = recipe.makes.text;
    // Mealie's import reads "1 9x13-inch lasagna" as 1 serving; don't keep that guess
    if (!recipe.servings) patch.recipeServings = 0;
  }
  // Mealie hides nutrition until a recipe's setting turns it on
  if (recipe.nutrition && saved.settings) patch.settings = { ...saved.settings, showNutrition: true };
  return patch;
}

/** A recipe already saved from this page, if any. */
export async function findBySourceUrl(raw: string): Promise<RecipeSummary | undefined> {
  let url: string;
  try {
    url = new URL(raw).toString(); // percent-encodes quotes; backslashes become slashes
  } catch {
    return;
  }
  const variants = new Set([url, url.replace(/\/$/, ""), url.endsWith("/") ? url : `${url}/`]);
  for (const v of variants) {
    // the value goes inside Mealie's filter syntax, so never let quotes or backslashes in
    if (/["\\]/.test(v)) continue;
    const params = new URLSearchParams({ perPage: "1", page: "1", queryFilter: `orgURL = "${v}"` });
    const data = await call<{ items: (RawRecipe & { orgURL?: string | null })[] }>(`/api/recipes?${params}`);
    const hit = data.items.find((r) => r.orgURL === v);
    if (hit) return summarize(hit);
  }
}

/**
 * Save a web recipe. This app fetches and reads the page itself (public addresses only),
 * so a link can't steer Mealie into the home network: Mealie only ever receives the recipe data.
 */
export async function importRecipe(recipe: Recipe): Promise<{ recipe: RecipeSummary; existed: boolean }> {
  const existing = await findBySourceUrl(recipe.sourceUrl);
  if (existing) return { recipe: existing, existed: true };
  const slug = await call<string>("/api/recipes/create/html-or-json", {
    method: "POST",
    body: JSON.stringify({ data: JSON.stringify(toSchemaJson(recipe)), includeTags: true, includeCategories: true }),
  });
  const saved = await call<RawRecipe>(`/api/recipes/${encodeURIComponent(slug)}`);
  await call(`/api/recipes/${encodeURIComponent(slug)}`, { method: "PATCH", body: JSON.stringify(afterImport(recipe, saved)) });
  if (recipe.imageUrl) {
    const img = await fetchImage(recipe.imageUrl).catch(() => null);
    if (img) {
      const form = new FormData();
      form.set("image", new Blob([new Uint8Array(img.bytes)]), `image.${img.ext}`);
      form.set("extension", img.ext);
      const res = await fetch(`${config.mealie.url}/api/recipes/${encodeURIComponent(slug)}/image`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${config.mealie.token}` },
        body: form,
        signal: AbortSignal.timeout(30_000),
      }).catch(() => null);
      if (!res?.ok) console.warn(`[mealie] photo upload for ${slug} failed (${res?.status ?? "network"})`);
    }
  }
  return { recipe: summarize(await call<RawRecipe>(`/api/recipes/${encodeURIComponent(slug)}`)), existed: false };
}

export interface MealPlanEntry {
  id: number;
  date: string;
  entryType: string;
  title: string;
  text: string;
  recipeId: string | null;
  recipe?: { name: string; slug: string } | null;
}

export async function listMealPlans(start: string, end: string): Promise<MealPlanEntry[]> {
  const params = new URLSearchParams({ start_date: start, end_date: end, perPage: "200", orderBy: "date", orderDirection: "asc" });
  const data = await call<{ items: MealPlanEntry[] }>(`/api/households/mealplans?${params}`);
  return data.items;
}

export async function createDinner(entry: { date: string; title?: string; text?: string; recipeId?: string | null }) {
  return call<MealPlanEntry>("/api/households/mealplans", {
    method: "POST",
    body: JSON.stringify({
      date: entry.date,
      entryType: "dinner",
      title: entry.title ?? "",
      text: entry.text ?? "",
      recipeId: entry.recipeId ?? null,
    }),
  });
}

export async function deleteMealPlan(id: string | number) {
  try {
    await call(`/api/households/mealplans/${id}`, { method: "DELETE" });
  } catch (e) {
    // already gone is fine
    if (!(e instanceof MealieError && e.message.includes("(404)"))) throw e;
  }
}

export async function mealieStatus(): Promise<{ connected: boolean; recipes?: number; error?: string }> {
  if (!mealieConfigured()) return { connected: false, error: "not configured" };
  try {
    const { total } = await searchRecipes("", 1);
    return { connected: true, recipes: total };
  } catch (e) {
    return { connected: false, error: (e as Error).message };
  }
}
