import { logActivity } from "./activity";
import { getDb, listUsers } from "./db";
import { addDays, weekday, weekStart } from "./dates";
import { llmJson } from "./llm";
import { addShoppingItems, AISLES, createShoppingList, deleteShoppingItems, getRecipe, getShoppingList, shoppingListUrl } from "./mealie";
import { listPantry } from "./pantry";
import { extractRecipe } from "./recipe";
import { getWeek } from "./week";

/** How many people dinner is for. Kids count as a full plate; leftovers are a feature. */
export const householdSize = () => Number(process.env.HOUSEHOLD_SIZE) || listUsers().length || 2;

// on hand in almost every kitchen; left off unless a recipe needs an unusual amount
const STAPLES = "salt, black pepper, water, ice, cooking oil (vegetable, canola, olive oil for cooking), cooking spray, all-purpose flour, white sugar";

const PROMPT = `You write a family's grocery list from the week's dinner recipes.
Answer with one JSON object and nothing else:
{"items": [{"text": "3 yellow onions", "aisle": "Produce", "for": ["Tue", "Thu"]}], "leftOff": ["salt", "olive oil"]}
Rules:
- Scale every recipe from its own servings to the number of people eating. When a recipe's servings are unknown, assume it already feeds the family. Follow each night's note ("double it for lunches").
- Combine the same ingredient across recipes into one item with the total amount ("2 lemons" + "1 lemon" = "3 lemons"; "1 cup + 2 tbsp butter" can become "1 1/4 cups butter").
- Write amounts the way you'd buy them: whole onions, a bunch of cilantro, a 28 oz can of tomatoes, "1.5 lb chicken thighs". Round up to what a store sells.
- Keep each item short: amount first, then the ingredient, plus a key detail only when it matters for buying (boneless, low-sodium).
- Leave off staples and anything the family says is already in the kitchen; list those names in leftOff instead. If a recipe needs a lot of a staple (2 cups of olive oil), keep it on the list.
- "for" lists the short day names of the dinners that use it.
- aisle is exactly one of: ${AISLES.join(", ")}.
- Order the items by aisle in that order.`;

interface Dish {
  day: string;
  title: string;
  servings: string | null;
  note: string | null;
  ingredients: string[];
}

export interface GroceryResult {
  listId: string;
  url: string;
  name: string;
  count: number;
  leftOff: string[];
  /** dinners whose ingredients couldn't be read */
  missing: string[];
  /** items already checked off in Mealie that were kept as they were */
  kept: number;
}

const core = (s: string) =>
  s
    .toLowerCase()
    .replace(/[\d½¼¾⅓⅔⅛.,/()-]+/g, " ")
    .replace(/\b(cups?|tbsps?|tablespoons?|tsps?|teaspoons?|lbs?|pounds?|oz|ounces?|g|kg|ml|cans?|bunch(es)?|heads?|cloves?|packages?|large|medium|small|about)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** What's planned this week, with each dinner's ingredients from Mealie or its web page. */
async function dishesFor(start: string): Promise<{ dishes: Dish[]; missing: string[] }> {
  const week = await getWeek(start);
  const dishes: Dish[] = [];
  const missing: string[] = [];
  for (const n of week.nights) {
    if (!n.cooking || !n.title) continue;
    try {
      if (n.recipeSlug) {
        const r = await getRecipe(n.recipeSlug);
        dishes.push({ day: n.day, title: n.title, servings: r.servings, note: n.note, ingredients: r.ingredients });
      } else if (n.sourceUrl) {
        const r = await extractRecipe(n.sourceUrl);
        dishes.push({
          day: n.day,
          title: n.title,
          servings: r.servings ? `${r.servings} servings` : r.recipeYield,
          note: n.note,
          ingredients: r.recipeIngredient,
        });
      } else {
        missing.push(`${n.day} (${n.title})`);
      }
    } catch (e) {
      console.warn(`[groceries] couldn't read ${n.title}:`, e);
      missing.push(`${n.day} (${n.title})`);
    }
  }
  return { dishes, missing };
}

let building: Promise<unknown> = Promise.resolve();

/**
 * Write the week's grocery list to Mealie: one list per week, rebuilt in place. Items this app
 * wrote before are replaced, except ones already checked off; items people added by hand stay.
 */
export function buildGroceryList(start: string, byUserId: number): Promise<GroceryResult> {
  const run = building.then(() => buildNow(weekStart(start), byUserId));
  building = run.catch(() => {});
  return run;
}

async function buildNow(start: string, byUserId: number): Promise<GroceryResult> {
  const { dishes, missing } = await dishesFor(start);
  if (!dishes.length) {
    throw new Error(missing.length ? `None of this week's dinners have a recipe to shop from (${missing.join(", ")}).` : "Nothing's planned this week yet.");
  }
  const people = householdSize();
  const pantry = listPantry().map((p) => p.item);
  const menu = dishes
    .map(
      (d) =>
        `${d.day}: ${d.title} (recipe makes: ${d.servings ?? "unknown"})${d.note ? `\nNote: ${d.note}` : ""}\n${d.ingredients.map((i) => `- ${i}`).join("\n")}`,
    )
    .join("\n\n");
  const out = await llmJson<{ items?: unknown; leftOff?: unknown }>(
    PROMPT,
    `People eating: ${people}\nStaples: ${STAPLES}\nAlready in the kitchen: ${pantry.join(", ") || "(nothing listed)"}\n\n${menu}`,
  );
  const items = (Array.isArray(out.items) ? out.items : [])
    .map((i) => i as { text?: unknown; aisle?: unknown; for?: unknown })
    .filter((i) => typeof i.text === "string" && i.text.trim())
    .slice(0, 120)
    .map((i) => {
      const days = Array.isArray(i.for) ? i.for.filter((x): x is string => typeof x === "string").slice(0, 7) : [];
      const aisle = AISLES.find((a) => a.toLowerCase() === String(i.aisle ?? "").toLowerCase()) ?? "Other";
      return { text: `${String(i.text).trim().slice(0, 120)}${days.length ? ` (${days.join(", ")})` : ""}`, aisle };
    });
  if (!items.length) throw new Error("Couldn't put a list together this time. Try again.");
  const leftOff = (Array.isArray(out.leftOff) ? out.leftOff : []).filter((x): x is string => typeof x === "string").slice(0, 30);

  const d = getDb();
  const name = `Groceries for ${weekday(start)} ${start.slice(5)} to ${weekday(addDays(start, 6))} ${addDays(start, 6).slice(5)}`;
  const prev = d.prepare("select list_id, item_ids from grocery_lists where week_start = ?").get(start) as
    | { list_id: string; item_ids: string }
    | undefined;
  let listId = prev?.list_id;
  let current = listId ? await getShoppingList(listId) : null;
  if (!current) {
    listId = await createShoppingList(name);
    current = { name, items: [] };
  }
  const ours = new Set<string>(prev && prev.list_id === listId ? JSON.parse(prev.item_ids) : []);
  const checked = current.items.filter((i) => i.checked);
  const checkedCores = new Set(checked.map((i) => core(i.note)));
  await deleteShoppingItems(current.items.filter((i) => ours.has(i.id) && !i.checked).map((i) => i.id));
  // already bought: don't put it back on the list
  const fresh = items.filter((i) => !checkedCores.has(core(i.text.replace(/\s*\([^)]*\)$/, ""))));
  const ids = await addShoppingItems(listId!, fresh);
  const keptIds = checked.filter((i) => ours.has(i.id)).map((i) => i.id);

  d.prepare(
    `insert into grocery_lists (week_start, list_id, item_ids, item_count, created_by, updated_at) values (?, ?, ?, ?, ?, datetime('now'))
     on conflict(week_start) do update set list_id = excluded.list_id, item_ids = excluded.item_ids,
       item_count = excluded.item_count, created_by = excluded.created_by, updated_at = excluded.updated_at`,
  ).run(start, listId, JSON.stringify([...ids, ...keptIds]), fresh.length, byUserId);
  logActivity(byUserId, `made the grocery list for the week of ${start} (${fresh.length} items)`);
  return { listId: listId!, url: shoppingListUrl(listId!), name: current.name, count: fresh.length, leftOff, missing, kept: checked.length };
}
