import { config, mealieConfigured } from "./config";
import { decodeEntities } from "./html";
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

/** One line of an ingredient list or method; `title` is a section heading that starts here. */
export interface RecipeLine {
  title?: string;
  text: string;
}

/** A recipe laid out for the in-app recipe card, rather than for Sal to read. */
export interface RecipeDetail {
  slug: string;
  name: string;
  description: string;
  /** null when Mealie doesn't know, or the recipe makes a thing rather than servings */
  servings: number | null;
  /** "1 loaf", "28 cookies" */
  makes: string | null;
  times: { prep: string | null; cook: string | null; total: string | null };
  ingredients: RecipeLine[];
  steps: RecipeLine[];
  notes: { title: string; text: string }[];
  nutrition: { label: string; value: string }[];
  sourceUrl: string | null;
  mealieUrl: string;
  hasImage: boolean;
}

/** Mealie slugs are lowercase letters, digits and hyphens; anything else never reaches Mealie. */
export const isRecipeSlug = (s: unknown): s is string => typeof s === "string" && /^[a-z0-9][a-z0-9-]{0,199}$/.test(s);

/** "PT1H10M" (older Mealie and schema.org) or plain text as is. */
function readableTime(text: string | null | undefined, seconds: number | null | undefined): string | null {
  const iso = text?.trim().match(/^P(?:\d+D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (iso) return readableSeconds(Number(iso[1] ?? 0) * 3600 + Number(iso[2] ?? 0) * 60 + Number(iso[3] ?? 0));
  return text?.trim() || readableSeconds(seconds);
}

const NUTRITION: [string, string, string][] = [
  // [Mealie key, label, unit added when the value is a bare number]
  ["calories", "Calories", ""],
  ["proteinContent", "Protein", "g"],
  ["carbohydrateContent", "Carbs", "g"],
  ["fatContent", "Fat", "g"],
  ["saturatedFatContent", "Saturated fat", "g"],
  ["fiberContent", "Fiber", "g"],
  ["sugarContent", "Sugar", "g"],
  ["sodiumContent", "Sodium", "mg"],
  ["cholesterolContent", "Cholesterol", "mg"],
];

const plainText = (s: string | null | undefined) => decodeEntities((s ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const webLink = (s: string | null | undefined) => (s && /^https?:\/\//i.test(s.trim()) ? s.trim() : null);

export async function getRecipeDetail(slug: string): Promise<RecipeDetail> {
  await loadGroupSlug();
  const r = await call<RawRecipe & { image?: string | null; cookTime?: string | null }>(`/api/recipes/${encodeURIComponent(slug)}`);
  let servings = r.recipeServings && r.recipeServings > 0 ? r.recipeServings : null;
  let makes: string | null = [r.recipeYieldQuantity || "", r.recipeYield ?? ""].join(" ").trim() || null;
  // older imports keep servings as yield text: "4 servings"
  const asServings = makes?.match(/^(\d+)\s*(servings?|people|portions?)?$/i);
  if (asServings) {
    servings ??= Number(asServings[1]);
    makes = null;
  }
  const lines = (items: { title?: string | null; text: string }[]) =>
    items
      .map((i) => ({ title: plainText(i.title) || undefined, text: plainText(i.text) }))
      .filter((i) => i.text || i.title);
  return {
    slug: r.slug,
    name: r.name,
    description: plainText(r.description),
    servings,
    makes,
    times: {
      prep: readableTime(r.prepTime, r.prepTimeSeconds),
      cook: readableTime(r.performTime || r.cookTime, r.performTimeSeconds),
      total: readableTime(r.totalTime, r.totalTimeSeconds),
    },
    ingredients: lines((r.recipeIngredient ?? []).map((i) => ({ title: i.title, text: i.display || i.originalText || i.note || "" }))),
    steps: lines(r.recipeInstructions ?? []),
    notes: (r.notes ?? []).map((n) => ({ title: plainText(n.title), text: plainText(n.text) })).filter((n) => n.title || n.text),
    nutrition: NUTRITION.flatMap(([key, label, unit]) => {
      const v = String(r.nutrition?.[key] ?? "").trim();
      if (!v || v === "0") return [];
      return [{ label, value: /^[\d.]+$/.test(v) && unit ? `${v} ${unit}` : v }];
    }),
    sourceUrl: webLink(r.orgURL),
    mealieUrl: recipeUrl(r.slug),
    hasImage: Boolean(r.image),
  };
}

// slug to Mealie's recipe id, so each photo request costs one call to Mealie, not two
const recipeIds = new Map<string, string>();

/**
 * The recipe photo from Mealie, smallest good size first. Null when there's no photo.
 * Only a slug that passed `isRecipeSlug` and the id Mealie returned for it go into the address.
 */
export async function getRecipeImage(slug: string): Promise<{ body: ReadableStream<Uint8Array>; type: string } | null> {
  let id = recipeIds.get(slug);
  if (!id) {
    const r = await call<{ id?: string; image?: string | null }>(`/api/recipes/${encodeURIComponent(slug)}`);
    if (!r.image || !r.id || !/^[0-9a-f-]{32,36}$/i.test(r.id)) return null;
    id = r.id;
    if (recipeIds.size > 500) recipeIds.clear();
    recipeIds.set(slug, id);
  }
  for (const file of ["min-original.webp", "original.webp"]) {
    const res = await fetch(`${config.mealie.url}/api/media/recipes/${id}/images/${file}`, {
      headers: { Authorization: `Bearer ${config.mealie.token}` },
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (res?.ok && res.body) return { body: res.body, type: res.headers.get("content-type") || "image/webp" };
    await res?.body?.cancel().catch(() => {});
  }
  return null;
}

/**
 * What Mealie's import loses, set exactly once the recipe exists: the source link,
 * ingredient section headings, servings next to "makes 1 loaf", and showing nutrition.
 */
function afterImport(recipe: Recipe, saved: RawRecipe): Record<string, unknown> {
  // recipes from a photo or a pasted message have no page to link back to
  const patch: Record<string, unknown> = recipe.sourceUrl ? { orgURL: recipe.sourceUrl } : {};
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

/** A recipe in the box with exactly this name, if any. */
export async function findByName(name: string): Promise<RecipeSummary | undefined> {
  const { recipes } = await searchRecipes(name, 10);
  return recipes.find((r) => r.name.trim().toLowerCase() === name.trim().toLowerCase());
}

/**
 * Save a web recipe. This app fetches and reads the page itself (public addresses only),
 * so a link can't steer Mealie into the home network: Mealie only ever receives the recipe data.
 */
export async function importRecipe(recipe: Recipe): Promise<{ recipe: RecipeSummary; existed: boolean }> {
  const existing = recipe.sourceUrl ? await findBySourceUrl(recipe.sourceUrl) : await findByName(recipe.name);
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

// ---------- after dinner: last made, rating, and a note on the recipe's timeline ----------

let selfId: string | null = null;
async function mealieUserId(): Promise<string> {
  selfId ??= (await call<{ id: string }>("/api/users/self")).id;
  return selfId;
}

/** Set the recipe's "last made" date. */
export async function markMade(slug: string, when: Date) {
  await call(`/api/recipes/${encodeURIComponent(slug)}/last-made`, { method: "PATCH", body: JSON.stringify({ timestamp: when.toISOString() }) });
}

/** Rate a recipe 1 to 5 as the Mealie user behind the API token (the household's account). */
export async function rateRecipe(slug: string, rating: number) {
  const id = await mealieUserId();
  await call(`/api/users/${id}/ratings/${encodeURIComponent(slug)}`, { method: "POST", body: JSON.stringify({ rating }) });
}

export async function addTimelineEvent(recipeId: string, subject: string, message: string, when: Date) {
  await call("/api/recipes/timeline/events", {
    method: "POST",
    body: JSON.stringify({ recipeId, subject, eventType: "comment", eventMessage: message, timestamp: when.toISOString() }),
  });
}

// ---------- tags and categories ----------

type Organizer = { id: string; name: string; slug: string };

async function listOrganizer(kind: "tags" | "categories"): Promise<Organizer[]> {
  const data = await call<{ items: Organizer[] }>(`/api/organizers/${kind}?perPage=500&page=1&orderBy=name&orderDirection=asc`);
  return data.items;
}

/** Names of the tags and categories already in the box, so new recipes reuse them. */
export async function organizerNames(): Promise<{ tags: string[]; categories: string[] }> {
  const [tags, categories] = await Promise.all([listOrganizer("tags"), listOrganizer("categories")]);
  return { tags: tags.map((t) => t.name), categories: categories.map((c) => c.name) };
}

async function resolveOrganizers(kind: "tags" | "categories", names: string[]): Promise<Organizer[]> {
  const existing = await listOrganizer(kind);
  const out: Organizer[] = [];
  for (const name of names) {
    const hit = existing.find((o) => o.name.toLowerCase() === name.toLowerCase());
    const o = hit ?? (await call<Organizer>(`/api/organizers/${kind}`, { method: "POST", body: JSON.stringify({ name }) }));
    if (!hit) existing.push(o);
    if (!out.some((x) => x.id === o.id)) out.push(o);
  }
  return out;
}

/** Replace a recipe's tags and categories, creating any that don't exist yet. */
export async function setOrganizers(slug: string, tags: string[], categories: string[]) {
  const [t, c] = await Promise.all([resolveOrganizers("tags", tags), resolveOrganizers("categories", categories)]);
  await call(`/api/recipes/${encodeURIComponent(slug)}`, { method: "PATCH", body: JSON.stringify({ tags: t, recipeCategory: c }) });
}

// ---------- shopping lists ----------

export interface ShoppingItem {
  id: string;
  note: string;
  checked: boolean;
  labelId: string | null;
}

export const shoppingListUrl = (id: string) => `${config.mealie.publicUrl}/shopping-lists/${id}`;

export async function createShoppingList(name: string): Promise<string> {
  return (await call<{ id: string }>("/api/households/shopping/lists", { method: "POST", body: JSON.stringify({ name }) })).id;
}

/** The list's items, or null if the list is gone. */
export async function getShoppingList(id: string): Promise<{ name: string; items: ShoppingItem[] } | null> {
  try {
    const l = await call<{ name: string; listItems?: (ShoppingItem & { display?: string })[] }>(`/api/households/shopping/lists/${encodeURIComponent(id)}`);
    return { name: l.name, items: (l.listItems ?? []).map((i) => ({ id: i.id, note: i.note || i.display || "", checked: i.checked, labelId: i.labelId })) };
  } catch (e) {
    if (e instanceof MealieError && e.message.includes("couldn't find")) return null;
    throw e;
  }
}

const LABEL_COLORS: Record<string, string> = {
  Produce: "#4CAF50",
  "Meat and seafood": "#E57373",
  "Dairy and eggs": "#FFD54F",
  Bakery: "#BCAAA4",
  Pantry: "#FFB74D",
  "Spices and seasonings": "#A1887F",
  Frozen: "#64B5F6",
  Other: "#90A4AE",
};
export const AISLES = Object.keys(LABEL_COLORS);

/** Label ids by name, creating Mealie labels for any aisle that doesn't have one yet. */
async function aisleLabels(names: string[]): Promise<Map<string, string>> {
  const data = await call<{ items: { id: string; name: string }[] }>("/api/groups/labels?perPage=200&page=1");
  const byName = new Map(data.items.map((l) => [l.name.toLowerCase(), l.id]));
  for (const name of new Set(names)) {
    if (byName.has(name.toLowerCase())) continue;
    const l = await call<{ id: string }>("/api/groups/labels", {
      method: "POST",
      body: JSON.stringify({ name, color: LABEL_COLORS[name] ?? "#90A4AE" }),
    });
    byName.set(name.toLowerCase(), l.id);
  }
  return byName;
}

export async function addShoppingItems(listId: string, items: { text: string; aisle: string }[]): Promise<string[]> {
  if (!items.length) return [];
  const labels = await aisleLabels(items.map((i) => i.aisle));
  const res = await call<{ createdItems: { id: string }[]; updatedItems: { id: string }[] }>("/api/households/shopping/items/create-bulk", {
    method: "POST",
    body: JSON.stringify(
      items.map((i, position) => ({
        shoppingListId: listId,
        note: i.text,
        quantity: 0,
        checked: false,
        position,
        labelId: labels.get(i.aisle.toLowerCase()) ?? null,
      })),
    ),
  });
  return [...res.createdItems, ...res.updatedItems].map((i) => i.id);
}

export async function deleteShoppingItems(ids: string[]) {
  if (!ids.length) return;
  const q = new URLSearchParams();
  for (const id of ids) q.append("ids", id);
  await call(`/api/households/shopping/items?${q}`, { method: "DELETE" });
}
