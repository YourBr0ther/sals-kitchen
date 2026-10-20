import { config, mealieConfigured } from "./config";

export class MealieError extends Error {}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!mealieConfigured()) throw new MealieError("Mealie isn't connected. Set MEALIE_URL and MEALIE_API_TOKEN.");
  const res = await fetch(`${config.mealie.url}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.mealie.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(30_000),
  });
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

export async function importRecipeFromUrl(url: string): Promise<RecipeSummary> {
  const slug = await call<string>("/api/recipes/create/url", {
    method: "POST",
    body: JSON.stringify({ url, includeTags: true, includeCategories: true }),
  });
  const r = await call<RawRecipe>(`/api/recipes/${encodeURIComponent(slug)}`);
  return summarize(r);
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
