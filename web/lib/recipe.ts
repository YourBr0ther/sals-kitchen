import OpenAI from "openai";
import { config } from "./config";
import { fetchText, fetchViaService, HttpStatusError } from "./web";

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
}

export class NoRecipeError extends Error {
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

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
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

function fromSchema(node: Json, sourceUrl: string, pageImage: string | null): Recipe {
  const img = firstImage(node.image) ?? pageImage;
  return {
    name: clean(String(node.name ?? "")),
    description: clean(String(node.description ?? "")).slice(0, 600),
    recipeYield: texts(node.recipeYield)[0] ?? null,
    prepTime: isoOrNull(node.prepTime),
    cookTime: isoOrNull(node.cookTime),
    totalTime: isoOrNull(node.totalTime),
    recipeIngredient: texts(node.recipeIngredient).slice(0, 80),
    recipeInstructions: texts(node.recipeInstructions).slice(0, 60),
    recipeCategory: texts(node.recipeCategory).slice(0, 5),
    recipeCuisine: texts(node.recipeCuisine).slice(0, 5),
    keywords: (typeof node.keywords === "string" ? node.keywords.split(",") : texts(node.keywords)).map((k) => k.trim()).filter(Boolean).slice(0, 10),
    imageUrl: img ? absolute(img, sourceUrl) : null,
    sourceUrl,
    via: "schema",
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

function pageText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|nav|iframe|form)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(br|\/p|\/li|\/h\d|\/div|\/tr)[^>]*>/gi, "\n")
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

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
{"found": true, "name": "...", "description": "one or two sentences from the page", "recipeYield": "4 servings" or null,
 "prepTime": "PT15M" or null, "cookTime": "PT25M" or null, "totalTime": "PT40M" or null,
 "recipeIngredient": ["1 lb chicken thighs", ...], "recipeInstructions": ["Heat the oil...", ...]}
Times are ISO 8601 durations. Each ingredient is one line with its amount. Each instruction is one step.
If the text has no complete recipe (both an ingredient list and steps), answer {"found": false}.`;

async function fromPageText(excerpt: string, title: string, sourceUrl: string, pageImage: string | null): Promise<Recipe> {
  const res = await llm().chat.completions.create({
    model: config.llm.model,
    temperature: 0,
    messages: [
      { role: "system", content: EXTRACT_PROMPT },
      { role: "user", content: `Page title: ${title}\nURL: ${sourceUrl}\n\n${excerpt}` },
    ],
  });
  const raw = res.choices[0]?.message?.content ?? "";
  const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  let data: Json;
  try {
    data = JSON.parse(json);
  } catch {
    throw new NoRecipeError("Couldn't read a recipe off that page.", title, excerpt.slice(0, 1500));
  }
  const ingredients = texts(data.recipeIngredient);
  const steps = texts(data.recipeInstructions);
  if (data.found === false || ingredients.length < 2 || steps.length < 1) {
    throw new NoRecipeError("That page doesn't have a complete recipe (ingredients and steps).", title, excerpt.slice(0, 1500));
  }
  return {
    name: clean(String(data.name ?? title)) || title,
    description: clean(String(data.description ?? "")).slice(0, 600),
    recipeYield: typeof data.recipeYield === "string" ? data.recipeYield : null,
    prepTime: isoOrNull(data.prepTime),
    cookTime: isoOrNull(data.cookTime),
    totalTime: isoOrNull(data.totalTime),
    recipeIngredient: ingredients.slice(0, 80),
    recipeInstructions: steps.slice(0, 60),
    recipeCategory: [],
    recipeCuisine: [],
    keywords: [],
    imageUrl: pageImage,
    sourceUrl,
    via: "page",
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
        const r = fromSchema(node, url, pageImage);
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
    } catch (e) {
      if (!(e instanceof NoRecipeError)) throw e;
      result = e;
    }
  }
  cache.set(url, { at: Date.now(), result });
  if (result instanceof NoRecipeError) throw result;
  return result;
}

/** The recipe as schema.org JSON for Mealie, with no URLs Mealie would go and fetch. */
export function toSchemaJson(r: Recipe): Json {
  const out: Json = {
    "@context": "https://schema.org",
    "@type": "Recipe",
    name: r.name,
    description: r.description,
    recipeIngredient: r.recipeIngredient,
    recipeInstructions: r.recipeInstructions.map((text) => ({ "@type": "HowToStep", text })),
  };
  if (r.recipeYield) out.recipeYield = r.recipeYield;
  if (r.prepTime) out.prepTime = r.prepTime;
  if (r.cookTime) out.cookTime = r.cookTime;
  if (r.totalTime) out.totalTime = r.totalTime;
  if (r.recipeCategory.length) out.recipeCategory = r.recipeCategory;
  if (r.recipeCuisine.length) out.recipeCuisine = r.recipeCuisine;
  if (r.keywords.length) out.keywords = r.keywords.join(", ");
  return out;
}
