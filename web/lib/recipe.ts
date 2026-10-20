import OpenAI from "openai";
import { config } from "./config";
import { UserError } from "./errors";
import { decodeEntities, htmlToText } from "./html";
import { type Heading, ingredientHeadings, type Note, recipeNotes } from "./recipe-card";
import { fetchText, fetchViaService, HttpStatusError } from "./web";

export { decodeEntities };
export type { Heading, Note };

/**
 * One recipe extractor shared by Sal's link reader and the Mealie import, so what
 * Sal saw on a page is exactly what gets saved.
 *
 * 1. schema.org Recipe in JSON-LD (most recipe sites), searched at any depth
 * 2. otherwise the page's recipe card, read by the chat model into the same shape
 */

export interface Recipe {
  name: string;
  description: string;
  recipeYield: string | null;
  prepTime: string | null;
  cookTime: string | null;
  totalTime: string | null;
  recipeIngredient: string[];
  recipeInstructions: string[];
  recipeCategory: string[];
  recipeCuisine: string[];
  keywords: string[];
  imageUrl: string | null;
  sourceUrl: string;
  /** how it was found: structured data on the page, or read from the page text */
  via: "schema" | "page";
  // Optional: recipes saved in pending approvals before these existed don't have them.
  /** section headings ("For the sauce") placed before recipeIngredient[at] */
  ingredientHeadings?: Heading[];
  /** section headings placed before recipeInstructions[at] */
  instructionHeadings?: Heading[];
  servings?: number | null;
  /** what the recipe makes when that isn't servings: "1 loaf", "28 cookies" */
  makes?: { quantity: number; text: string } | null;
  /** schema.org NutritionInformation keys Mealie stores, per serving */
  nutrition?: Record<string, string>;
  notes?: Note[];
}

export class NoRecipeError extends UserError {
  constructor(
    message: string,
    readonly title = "",
    readonly excerpt = "",
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;

const isRecipeType = (t: unknown) =>
  t === "Recipe" || t === "schema:Recipe" || (Array.isArray(t) && t.some((x) => x === "Recipe" || x === "schema:Recipe"));

/** Depth-first search for a Recipe node: top level, @graph, mainEntity, or anywhere else. */
function findRecipeNode(node: unknown, depth = 0): Json | undefined {
  if (!node || typeof node !== "object" || depth > 8) return;
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = findRecipeNode(n, depth + 1);
      if (r) return r;
    }
    return;
  }
  const obj = node as Json;
  if (isRecipeType(obj["@type"])) return obj;
  for (const v of Object.values(obj)) {
    const r = findRecipeNode(v, depth + 1);
    if (r) return r;
  }
}

const clean = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** Strings out of the many shapes schema.org allows: text, lists, HowToStep, HowToSection. */
function texts(v: unknown): string[] {
  if (v == null) return [];
  if (typeof v === "string") return v.includes("\n") ? v.split(/\n+/).map(clean).filter(Boolean) : [clean(v)].filter(Boolean);
  if (typeof v === "number") return [String(v)];
  if (Array.isArray(v)) return v.flatMap(texts);
  const o = v as Json;
  if (o.itemListElement) return texts(o.itemListElement);
  if (o.text) return texts(o.text);
  if (o.name) return texts(o.name);
  return [];
}

function firstImage(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return firstImage(v[0]);
  const o = v as Json;
  return typeof o.url === "string" ? o.url : typeof o.contentUrl === "string" ? o.contentUrl : null;
}

const isoOrNull = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Lines plus section headings, from schema.org HowToSection groups or the model's
 * {"section", "items"} groups. Plain lists come back with no headings.
 */
function sectioned(v: unknown, max: number): { lines: string[]; headings: Heading[] } {
  const lines: string[] = [];
  const headings: Heading[] = [];
  const walk = (x: unknown) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (x && typeof x === "object") {
      const o = x as Json;
      const isSection = o["@type"] === "HowToSection" || o.type === "HowToSection" || "items" in o;
      if (isSection) {
        const title = clean(String(o.name ?? o.section ?? "")).replace(/[\s:]+$/, "");
        const before = lines.length;
        walk(o.itemListElement ?? o.items);
        if (title && lines.length > before) headings.push({ at: before, title });
        return;
      }
    }
    lines.push(...texts(x));
  };
  walk(v);
  // nested sections finish inner-first; keep headings in line order
  return { lines: lines.slice(0, max), headings: headings.filter((h) => h.at < max).sort((a, b) => a.at - b.at) };
}

// WP Recipe Maker's schema output wraps ingredient notes as "(, minced)"
const tidyIngredient = (s: string) => s.replace(/\(\s*,\s*/g, "(");

const SERVING_WORDS = /\b(servings?|serving\(s\)|serves|feeds|people|persons?|portions?)\b/i;

/**
 * Pages give yield as "4", "4 servings", ["4", "4 - 5 people"], or "1 loaf, 10 serving(s)".
 * Mealie keeps servings and "what it makes" (1 loaf) as separate fields, so split them.
 */
function readYield(raw: string[]): Pick<Recipe, "recipeYield" | "servings" | "makes"> {
  const parts = raw.flatMap((s) => s.split(/,\s*/)).map((s) => s.trim()).filter(Boolean);
  let servings: number | null = null;
  let makes: Recipe["makes"] = null;
  for (const p of parts) {
    const n = Number(p.match(/\d+(\.\d+)?/)?.[0]);
    if (!n) continue;
    if (/^\d+(\.\d+)?$/.test(p) || SERVING_WORDS.test(p)) servings ??= n;
    // "8 about 4 meatballs each" describes a serving, not what the recipe makes
    else if (!makes && !/\b(each|per)\b/i.test(p)) {
      const m = p.match(/^(?:makes\s+)?(?:about\s+)?(\d+(?:\.\d+)?)\s+(.+)$/i);
      makes = m ? { quantity: Number(m[1]), text: m[2] } : { quantity: 0, text: p };
    }
  }
  // the most descriptive version for people to read ("4 - 5 people" over "4")
  const display = raw.find((s) => /[a-z]/i.test(s)) ?? raw[0] ?? null;
  return { recipeYield: display, servings, makes };
}

// the NutritionInformation fields Mealie has a place for
const NUTRITION_KEYS = [
  "calories",
  "carbohydrateContent",
  "cholesterolContent",
  "fatContent",
  "fiberContent",
  "proteinContent",
  "saturatedFatContent",
  "sodiumContent",
  "sugarContent",
  "transFatContent",
  "unsaturatedFatContent",
];

function readNutrition(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return;
  const out: Record<string, string> = {};
  for (const k of NUTRITION_KEYS) {
    const val = (v as Json)[k];
    if ((typeof val === "string" || typeof val === "number") && /\d/.test(String(val))) out[k] = clean(String(val));
  }
  return Object.keys(out).length ? out : undefined;
}

function fromSchema(node: Json, sourceUrl: string, pageImage: string | null, html: string): Recipe {
  const img = firstImage(node.image) ?? pageImage;
  const ingredients = texts(node.recipeIngredient).map(tidyIngredient).slice(0, 80);
  const steps = sectioned(node.recipeInstructions, 60);
  const notes = recipeNotes(html);
  return {
    name: clean(String(node.name ?? "")),
    description: clean(String(node.description ?? "")).slice(0, 1500),
    ...readYield(texts(node.recipeYield)),
    prepTime: isoOrNull(node.prepTime),
    cookTime: isoOrNull(node.cookTime),
    totalTime: isoOrNull(node.totalTime),
    recipeIngredient: ingredients,
    recipeInstructions: steps.lines,
    recipeCategory: texts(node.recipeCategory).slice(0, 5),
    recipeCuisine: texts(node.recipeCuisine).slice(0, 5),
    // King Arthur separates keywords with ";;"
    keywords: (typeof node.keywords === "string" ? node.keywords.split(/[,;]/) : texts(node.keywords)).map((k) => k.trim()).filter(Boolean).slice(0, 10),
    imageUrl: img ? absolute(img, sourceUrl) : null,
    sourceUrl,
    via: "schema",
    // schema.org has no ingredient groups; recipe-card plugins show them in the page itself
    ingredientHeadings: ingredientHeadings(html, ingredients.length),
    instructionHeadings: steps.headings.length ? steps.headings : undefined,
    nutrition: readNutrition(node.nutrition),
    notes: notes.length ? notes : undefined,
  };
}

function absolute(u: string, base: string): string | null {
  try {
    return new URL(u, base).toString();
  } catch {
    return null;
  }
}

function meta(html: string, prop: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, "i");
  const tag = html.match(re)?.[0];
  return tag ? decodeEntities(tag.match(/content=["']([^"']*)["']/i)?.[1] ?? "") || null : null;
}

// Recipe-card plugins put the actual recipe in one container; start reading there.
// Matched as class names inside <body>, since the same words show up in stylesheet links.
const CARD = /class=["'][^"']*\b(wprm-recipe-container|wprm-recipe|tasty-recipes|mv-create-card|recipe-card|easyrecipe|cooked-recipe|zlrecipe)\b|itemtype=["']https?:\/\/schema\.org\/Recipe["']/i;

const pageText = htmlToText;

const MEASURE = /\b(\d+\s*\/\s*\d+|\d+(\.\d+)?|½|¼|¾|⅓|⅔)\s*(cups?|c\.|tbsps?|tablespoons?|tsps?|teaspoons?|lbs?|pounds?|oz|ounces?|g|grams?|kg|ml|l|cloves?|cans?|pinch|dash|sticks?|slices?|large|medium|small|whole|packages?|pkgs?\.?)\b/gi;

/**
 * In plain page text, the stretch most likely to be the recipe: the "Ingredients" mention
 * followed by the most measurements (blog posts say "ingredients" in FAQs and tips too).
 */
function excerptFromText(text: string): string {
  const lower = text.toLowerCase();
  let best = -1;
  let bestScore = 2; // need at least 3 measured lines to count as an ingredient list
  for (let i = lower.indexOf("ingredient"); i >= 0; i = lower.indexOf("ingredient", i + 1)) {
    const score = (text.slice(i, i + 2500).match(MEASURE) ?? []).length;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  return best >= 0 ? text.slice(Math.max(0, best - 400), best + 10000) : text.slice(0, 10000);
}

/** The part of a long blog post most likely to be the recipe itself. */
function recipeExcerpt(html: string): string {
  const bodyAt = Math.max(0, html.search(/<body[\s>]/i));
  const body = html.slice(bodyAt);
  const card = body.search(CARD);
  if (card >= 0) {
    const text = pageText(body.slice(body.lastIndexOf("<", card)));
    if (/ingredient/i.test(text.slice(0, 9000))) return text.slice(0, 10000);
  }
  return excerptFromText(pageText(body));
}

let client: OpenAI | undefined;
const llm = () => (client ??= new OpenAI({ baseURL: config.llm.baseURL, apiKey: config.llm.apiKey }));

const EXTRACT_PROMPT = `You pull recipes out of web page text for a recipe manager.
Copy the recipe exactly as the page gives it. Never invent, complete, or improve anything.
Answer with one JSON object and nothing else:
{"found": true, "name": "...", "description": "one or two sentences from the text" or "", "recipeYield": "4 servings" or null,
 "servings": 4 or null, "prepTime": "PT15M" or null, "cookTime": "PT25M" or null, "totalTime": "PT40M" or null,
 "recipeIngredient": ["1 lb chicken thighs", ...], "recipeInstructions": ["Heat the oil...", ...],
 "nutrition": {"calories": "567", "fatContent": "31 g", "carbohydrateContent": "36 g", "proteinContent": "36 g"} or null,
 "notes": ["..."] or null}
description: only a sentence the text itself gives to describe the dish; "" if there is none. Never write one, and never use ratings, servings, or times as the description.
Times are ISO 8601 durations. A single time that isn't labeled prep or cook ("Serves 4, 45 min") is the totalTime.
name: the recipe's name without asides like "(So Easy!)".
Each ingredient is one line with its amount. Each instruction is one step.
recipeYield is what the page says it makes ("1 9x13-inch lasagna", "28 cookies"); servings is the number of servings only if the page states it ("serves 6", "feeds 6").
If the page splits ingredients or steps into titled groups ("For the sauce:"), give that list as
[{"section": "For the sauce", "items": ["...", ...]}, ...] instead, with the groups in page order.
nutrition: only if the page lists nutrition facts, per serving, using the schema.org NutritionInformation names
(calories, fatContent, saturatedFatContent, carbohydrateContent, sugarContent, fiberContent, proteinContent, cholesterolContent, sodiumContent).
notes: only text the page labels as the recipe's notes or tips, one entry per note; otherwise null.
If the text has no complete recipe (both an ingredient list and steps), answer {"found": false, "reason": "what's missing, in a few plain words"}.`;

async function readRecipeText(excerpt: string, title: string, sourceUrl: string): Promise<Json | null> {
  const res = await llm().chat.completions.create({
    model: config.llm.model,
    temperature: 0,
    messages: [
      { role: "system", content: EXTRACT_PROMPT },
      {
        role: "user",
        content: sourceUrl
          ? `Page title: ${title}\nURL: ${sourceUrl}\n\n${excerpt}`
          : `A recipe someone typed, pasted, or photographed${title ? ` (probably called "${title}")` : ""}:\n\n${excerpt}`,
      },
    ],
  });
  const raw = res.choices[0]?.message?.content ?? "";
  try {
    return JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  } catch {
    return null;
  }
}

const isoMinutes = (iso: string | null) => {
  const m = iso?.match(/^PT(?:(\d+)H)?(?:(\d+)M)?$/i);
  return m && (m[1] || m[2]) ? Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0) : null;
};

async function fromPageText(excerpt: string, title: string, sourceUrl: string, pageImage: string | null): Promise<Recipe> {
  // the model now and then answers with broken JSON; one more try usually comes back clean
  const data = (await readRecipeText(excerpt, title, sourceUrl)) ?? (await readRecipeText(excerpt, title, sourceUrl));
  // a garbled reply says nothing about the page; don't cache it as "no recipe"
  if (!data) throw new UserError(`Couldn't read the recipe ${sourceUrl ? "off that page" : "from that"} this time. Try again.`);
  const ingredients = sectioned(data.recipeIngredient, 80);
  const steps = sectioned(data.recipeInstructions, 60);
  if (data.found === false || ingredients.lines.length < 2 || steps.lines.length < 1) {
    if (sourceUrl) throw new NoRecipeError("That page doesn't have a complete recipe (ingredients and steps).", title, excerpt.slice(0, 1500));
    // from chat, say what's missing so the person knows what to send
    const reason =
      ingredients.lines.length >= 2 && !steps.lines.length
        ? "it lists ingredients but no steps"
        : steps.lines.length && ingredients.lines.length < 2
          ? "it has steps but no ingredient list"
          : typeof data.reason === "string" && data.reason.trim()
            ? clean(data.reason).replace(/\.$/, "").replace(/^\p{Lu}(?=\p{Ll})/u, (c) => c.toLowerCase()).slice(0, 160)
            : "there's no ingredient list and steps in it";
    throw new NoRecipeError(`That isn't a whole recipe yet: ${reason}.`, title, excerpt.slice(0, 1500));
  }
  const servings = typeof data.servings === "number" && data.servings > 0 ? `${data.servings} servings` : null;
  const yieldText = typeof data.recipeYield === "string" ? data.recipeYield : null;
  const notes = texts(data.notes).filter((n) => n.length > 3);
  const [prepTime, cookTime] = [isoOrNull(data.prepTime), isoOrNull(data.cookTime)];
  // a card that gives prep and cook rarely adds them up; Mealie shows the total on its cards
  const prepMin = isoMinutes(prepTime);
  const cookMin = isoMinutes(cookTime);
  const totalTime = isoOrNull(data.totalTime) ?? (prepMin != null && cookMin != null ? `PT${prepMin + cookMin}M` : null);
  let name = clean(String(data.name ?? title)) || title;
  // "mom's chili" typed in a text message reads better in the box as "Mom's Chili"
  if (!sourceUrl && name === name.toLowerCase()) name = name.replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase());
  return {
    name,
    description: clean(String(data.description ?? "")).slice(0, 1500),
    ...readYield([yieldText, servings].filter((s): s is string => !!s)),
    prepTime,
    cookTime,
    totalTime,
    recipeIngredient: ingredients.lines,
    recipeInstructions: steps.lines,
    recipeCategory: [],
    recipeCuisine: [],
    keywords: [],
    imageUrl: pageImage,
    sourceUrl,
    via: "page",
    ingredientHeadings: ingredients.headings.length ? ingredients.headings : undefined,
    instructionHeadings: steps.headings.length ? steps.headings : undefined,
    nutrition: readNutrition(data.nutrition),
    notes: notes.length ? [{ title: "Notes", text: notes.join("\n\n").slice(0, 5000) }] : undefined,
  };
}

const cache = new Map<string, { at: number; result: Recipe | NoRecipeError }>();
const CACHE_MS = 60 * 60_000;

/** Fetch a page (public addresses only) and pull out its recipe. Throws NoRecipeError if there isn't one. */
export async function extractRecipe(url: string): Promise<Recipe> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    if (hit.result instanceof NoRecipeError) throw hit.result;
    return hit.result;
  }
  let page: { html: string; finalUrl: string };
  try {
    page = await fetchText(url);
  } catch (e) {
    // some big recipe sites block anything that isn't a browser; try NanoGPT's fetcher
    if (!(e instanceof HttpStatusError) || e.status === 404 || e.status === 410) throw e;
    const viaService = await fetchViaService(url);
    const result = await fromPageText(excerptFromText(viaService.text), viaService.title, url, null).catch((err) => {
      if (err instanceof NoRecipeError) return err;
      throw err;
    });
    cache.set(url, { at: Date.now(), result });
    if (result instanceof NoRecipeError) throw result;
    return result;
  }
  const { html, finalUrl } = page;
  const title = clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "") || (meta(html, "og:title") ?? "");
  const ogImage = meta(html, "og:image");
  const pageImage = ogImage ? absolute(ogImage, finalUrl) : null;

  let result: Recipe | NoRecipeError | undefined;
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const node = findRecipeNode(JSON.parse(m[1].trim()));
      if (node) {
        const r = fromSchema(node, url, pageImage, html);
        // some sites publish a Recipe node with no ingredients; fall through to the page text
        if (r.recipeIngredient.length >= 2 && r.recipeInstructions.length >= 1) result = r;
        break;
      }
    } catch {
      // malformed JSON-LD blocks are common; try the next one
    }
  }
  if (!result) {
    try {
      result = await fromPageText(recipeExcerpt(html), title, url, pageImage);
      // a recipe card's notes are easier to read off the HTML than out of the excerpt
      if (!result.notes) {
        const notes = recipeNotes(html);
        if (notes.length) result.notes = notes;
      }
    } catch (e) {
      if (!(e instanceof NoRecipeError)) throw e;
      result = e;
    }
  }
  cache.set(url, { at: Date.now(), result });
  if (result instanceof NoRecipeError) throw result;
  return result;
}

/**
 * A recipe from chat: pasted text, or the transcription of a photographed card or cookbook page.
 * Throws NoRecipeError when the text doesn't hold a whole recipe.
 */
export function recipeFromText(text: string, title = ""): Promise<Recipe> {
  return fromPageText(text.slice(0, 12000), title, "", null);
}

/** The recipe as schema.org JSON for Mealie, with no URLs Mealie would go and fetch. */
export function toSchemaJson(r: Recipe): Json {
  const out: Json = {
    "@context": "https://schema.org",
    "@type": "Recipe",
    name: r.name,
    description: r.description,
    recipeIngredient: r.recipeIngredient,
    // Mealie keeps a HowToSection's name as a heading on its first step
    recipeInstructions: withSections(
      r.recipeInstructions.map((text) => ({ "@type": "HowToStep", text })),
      r.instructionHeadings,
    ),
  };
  // Mealie reads one yield value; servings and "makes" are both set exactly after import
  const yieldText = r.servings ? `${r.servings} servings` : r.makes ? `${r.makes.quantity || ""} ${r.makes.text}`.trim() : r.recipeYield;
  if (yieldText) out.recipeYield = yieldText;
  if (r.prepTime) out.prepTime = r.prepTime;
  if (r.cookTime) out.cookTime = r.cookTime;
  if (r.totalTime) out.totalTime = r.totalTime;
  // No keywords or recipeCategory: Mealie would turn every page keyword ("lentil soup recipe",
  // "Main Course") into a tag or category of its own. autoTag files the recipe right after saving.
  if (r.nutrition) out.nutrition = { "@type": "NutritionInformation", ...r.nutrition };
  if (r.notes?.length) out.notes = r.notes;
  return out;
}

function withSections(steps: Json[], headings: Heading[] | undefined): Json[] {
  if (!headings?.length) return steps;
  const out: Json[] = steps.slice(0, headings[0].at);
  headings.forEach((h, i) => {
    const items = steps.slice(h.at, headings[i + 1]?.at ?? steps.length);
    if (items.length) out.push({ "@type": "HowToSection", name: h.title, itemListElement: items });
  });
  return out;
}
