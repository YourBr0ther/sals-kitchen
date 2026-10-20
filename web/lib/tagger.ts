import { llmJson } from "./llm";
import { organizerNames, setOrganizers } from "./mealie";
import type { Recipe } from "./recipe";

const PROMPT = `You file recipes in a family's recipe box so they're easy to find later.
Pick tags and categories for the recipe. Answer with one JSON object and nothing else:
{"main": "Chicken", "tags": ["Chicken", "Italian", "Weeknight"], "categories": ["Dinner"]}
main: the one main protein or ingredient, always: Chicken, Beef, Pork, Sausage, Fish, Salmon, Shrimp, Beans, Lentils, Tofu, Pasta, Rice, Eggs, Potatoes...
For sweets and baking, the flavor that leads: Chocolate, Lemon, Apple, Banana.
Tags (2 to 5), in this order:
1. main.
2. The cuisine, only when it's unmistakable (tacos are Mexican; lemon chicken with oregano isn't automatically Italian): Italian, Mexican, Cajun, Thai...
   Not American: recipe sites label nearly everything American.
3. At most two practical tags, only when the recipe plainly is one: Weeknight (under 45 minutes total; leave it off when the time is unknown), One Pot (cooked in a single pot or pan, start to finish), Sheet Pan, Slow Cooker, Grill, Make Ahead, Vegetarian (no meat or fish at all), Spicy.
Categories (usually 1): the kind of dish, such as Dinner, Side, Soup, Salad, Breakfast, Dessert, Baking, Snack, Drink, Sauce. Add a second only if it's genuinely both.
Reuse the box's existing tags and categories whenever one means the same thing, spelled exactly the same. Never use an existing tag just because it exists.
Use short Title Case names. No marketing words ("Best", "Easy", "Quick", "Delicious"), no dish names as tags, no categories as tags.`;

// words that say nothing about what a recipe is
const JUNK = /\b(best|easy|easiest|quick|simple|delicious|yummy|perfect|ultimate|recipes?|homemade|family|favorite|dinner ideas?)\b/i;

/** "One-pot", "one pot" and "One Pots" are the same tag. */
const key = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    // plurals: "Potatoes" is "Potato", "Sides" is "Side", "Swiss" stays
    .replace(/(?<=o|x|ch|sh|ss)es$/, "")
    .replace(/(?<!s)s$/, "");

const titleCase = (s: string) => s.replace(/(^|[\s-])\p{L}/gu, (c) => c.toUpperCase());

/**
 * Clean the model's names: drop junk, fold near-duplicates onto names already in the box
 * (Mealie would otherwise keep "One pot" and "One Pot" side by side), and dedupe.
 */
function tidy(names: unknown[], existing: string[], max: number, avoid: Set<string> = new Set()): string[] {
  const known = new Map(existing.map((n) => [key(n), n]));
  const out = new Map<string, string>();
  for (const raw of names) {
    if (typeof raw !== "string") continue;
    const name = raw.trim().replace(/\s+/g, " ").slice(0, 40);
    const k = key(name);
    if (!k || avoid.has(k) || out.has(k) || name.split(" ").length > 3 || JUNK.test(name)) continue;
    out.set(k, known.get(k) ?? titleCase(name));
  }
  return [...out.values()].slice(0, max);
}

/**
 * Give a newly saved recipe tags and categories that match the rest of the box.
 * Pages' own keywords are mostly search-engine filler, so they're only hints here.
 */
export async function autoTag(slug: string, recipe: Recipe): Promise<{ tags: string[]; categories: string[] }> {
  const existing = await organizerNames();
  const labels = [...recipe.recipeCategory, ...recipe.recipeCuisine, ...recipe.keywords];
  const times = [
    recipe.prepTime && `prep ${recipe.prepTime}`,
    recipe.cookTime && `cook ${recipe.cookTime}`,
    recipe.totalTime && `total ${recipe.totalTime}`,
  ].filter(Boolean);
  const card = [
    `Name: ${recipe.name}`,
    recipe.description && `Description: ${recipe.description}`,
    `Ingredients:\n${recipe.recipeIngredient.slice(0, 30).join("\n")}`,
    `Steps:\n${recipe.recipeInstructions.slice(0, 12).join("\n").slice(0, 2000)}`,
    `Time: ${times.join(", ") || "unknown"}`,
    labels.length && `The page's own labels (hints only): ${labels.join(", ")}`,
  ]
    .filter(Boolean)
    .join("\n");
  type Picks = { main?: unknown; tags?: unknown; categories?: unknown };
  const out: Picks = await llmJson<Picks>(
    PROMPT,
    `Existing tags: ${existing.tags.join(", ") || "(none yet)"}\nExisting categories: ${existing.categories.join(", ") || "(none yet)"}\n\n${card}`,
  ).catch((e) => {
    // without the model, file it only under the page's labels the box already has
    console.warn(`[tagger] ${slug}: falling back to page labels:`, e);
    const has = (names: string[]) => (l: string) => names.some((n) => key(n) === key(l));
    return { tags: labels.filter(has(existing.tags)), categories: labels.filter(has(existing.categories)) };
  });
  const categories = tidy(Array.isArray(out.categories) ? out.categories : [], existing.categories, 2);
  // the main ingredient always leads, even when the model left it out of the list
  const tags = tidy([out.main, ...(Array.isArray(out.tags) ? out.tags : [])], existing.tags, 5, new Set(categories.map(key)));
  if (tags.length || categories.length) await setOrganizers(slug, tags, categories);
  return { tags, categories };
}
