import { llmJson } from "./llm";
import { organizerNames, setOrganizers } from "./mealie";
import type { Recipe } from "./recipe";

const PROMPT = `You file recipes in a family's recipe box so they're easy to find later.
Pick tags and categories for the recipe. Answer with one JSON object and nothing else:
{"tags": ["Italian", "Chicken", "Weeknight"], "categories": ["Dinner"]}
Tags (2 to 5), in this order:
1. The main protein or ingredient, always: Chicken, Beef, Pork, Fish, Shrimp, Beans, Tofu, Pasta, Eggs...
2. The cuisine, when it has a clear one: Italian, Mexican, Cajun, Thai...
3. At most two practical tags, only when the recipe plainly is one: Weeknight (under 45 minutes total), One pot (cooked in a single pot or pan, start to finish), Sheet pan, Slow cooker, Grill, Make ahead, Vegetarian, Spicy.
Categories (usually 1): the kind of dish, such as Dinner, Side, Soup, Salad, Breakfast, Dessert, Baking, Snack, Drink, Sauce. Add a second only if it's genuinely both.
Reuse the box's existing tags and categories whenever one means the same thing, spelled exactly the same. Never use an existing tag just because it exists.
Use short title-case names. No marketing phrases ("best", "easy recipe"), no dish names as tags.`;

/**
 * Give a newly saved recipe tags and categories that match the rest of the box.
 * Pages' own keywords are mostly search-engine filler, so they're only hints here.
 */
export async function autoTag(slug: string, recipe: Recipe): Promise<{ tags: string[]; categories: string[] }> {
  const existing = await organizerNames();
  const card = [
    `Name: ${recipe.name}`,
    recipe.description && `Description: ${recipe.description}`,
    `Ingredients:\n${recipe.recipeIngredient.slice(0, 30).join("\n")}`,
    recipe.totalTime && `Total time: ${recipe.totalTime}`,
    [...recipe.recipeCategory, ...recipe.recipeCuisine, ...recipe.keywords].length &&
      `The page's own labels (hints only): ${[...recipe.recipeCategory, ...recipe.recipeCuisine, ...recipe.keywords].join(", ")}`,
  ]
    .filter(Boolean)
    .join("\n");
  const out = await llmJson<{ tags?: unknown; categories?: unknown }>(
    PROMPT,
    `Existing tags: ${existing.tags.join(", ") || "(none yet)"}\nExisting categories: ${existing.categories.join(", ") || "(none yet)"}\n\n${card}`,
  );
  const names = (v: unknown, max: number) =>
    (Array.isArray(v) ? v : [])
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.trim().slice(0, 40))
      .filter(Boolean)
      .slice(0, max);
  const tags = names(out.tags, 5);
  const categories = names(out.categories, 2);
  if (tags.length || categories.length) await setOrganizers(slug, tags, categories);
  return { tags, categories };
}
