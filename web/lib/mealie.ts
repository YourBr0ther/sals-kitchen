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
    throw new MealieError(`Mealie ${init.method ?? "GET"} ${path} failed (${res.status}): ${body.slice(0, 300)}`);
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
  tags?: { name: string }[];
  recipeCategory?: { name: string }[];
  rating?: number | null;
  lastMade?: string | null;
  recipeYield?: string | null;
  orgURL?: string | null;
  recipeIngredient?: { display?: string; note?: string; originalText?: string }[];
  recipeInstructions?: { text: string }[];
  notes?: { title: string; text: string }[];
};

const recipeUrl = (slug: string) => `${config.mealie.publicUrl}/g/home/r/${slug}`;

function summarize(r: RawRecipe): RecipeSummary {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: (r.description ?? "").slice(0, 240),
    totalTime: r.totalTime || r.performTime || r.prepTime || null,
    tags: (r.tags ?? []).map((t) => t.name),
    categories: (r.recipeCategory ?? []).map((c) => c.name),
    rating: r.rating ?? null,
    lastMade: r.lastMade ?? null,
    url: recipeUrl(r.slug),
  };
}

export async function searchRecipes(query: string, perPage = 12): Promise<{ total: number; recipes: RecipeSummary[] }> {
  const params = new URLSearchParams({ perPage: String(perPage), page: "1", orderBy: "name", orderDirection: "asc" });
  if (query.trim()) params.set("search", query.trim());
  const data = await call<{ total: number; items: RawRecipe[] }>(`/api/recipes?${params}`);
  return { total: data.total, recipes: data.items.map(summarize) };
}

export async function getRecipe(slug: string) {
  const r = await call<RawRecipe>(`/api/recipes/${encodeURIComponent(slug)}`);
  return {
    ...summarize(r),
    servings: r.recipeYield ?? null,
    source: r.orgURL ?? null,
    ingredients: (r.recipeIngredient ?? []).map((i) => i.display || i.originalText || i.note || "").filter(Boolean),
    steps: (r.recipeInstructions ?? []).map((s) => s.text),
    notes: (r.notes ?? []).map((n) => `${n.title}: ${n.text}`),
  };
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
  await call(`/api/recipes/${encodeURIComponent(slug)}`, { method: "PATCH", body: JSON.stringify({ orgURL: recipe.sourceUrl }) });
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
