import { logActivity } from "./activity";
import { getDb, listUsers } from "./db";
import { addDays, localDate, shortDate, weekday, weekStart } from "./dates";
import { llmJson } from "./llm";
import { addShoppingItems, AISLES, createShoppingList, deleteShoppingItems, getRecipe, getShoppingList, labelNames, shoppingListUrl } from "./mealie";
import { listPantry } from "./pantry";
import { UserError } from "./errors";
import { extractRecipe, NoRecipeError } from "./recipe";
import { getWeek } from "./week";

/** How many people dinner is for. Kids count as a full plate; leftovers are a feature. */
export const householdSize = () => Number(process.env.HOUSEHOLD_SIZE) || listUsers().length || 2;

// on hand in almost every kitchen; left off unless a recipe needs an unusual amount
const STAPLES = "salt, black pepper, water, ice, cooking oil (vegetable, canola, olive oil for cooking), cooking spray, all-purpose flour, white sugar";

const PROMPT = `You write a family's grocery list from the week's dinner recipes.
Answer with one JSON object and nothing else:
{"items": [{"text": "3 yellow onions", "aisle": "Produce", "for": ["Tue", "Thu"]}], "leftOff": ["salt", "olive oil"]}
Rules:
- Scale every recipe from its own servings to the number of people eating. When a recipe's servings are unknown, assume it already feeds the family. Follow each night's note: "double it for lunches" means twice what the family needs, so scale to the family first, then double.
- Combine the same ingredient across recipes into one item with the total amount ("2 lemons" + "1 lemon" = "3 lemons"; "1 cup + 2 tbsp butter" can become "1 1/4 cups butter").
- Write amounts the way you'd buy them, rounded up to what a store sells: whole onions and lemons (2.25 lemons is 3 lemons), a bunch of cilantro, a 28 oz can of tomatoes, "1.5 lb chicken thighs", "1 lb ground chicken" (not 3/4 lb), a dozen eggs, a wedge of Parmesan, a pint of heavy cream. Never cups, tablespoons, or teaspoons for something sold in a package; spices and condiments are just "chili powder" or "1 jar salsa".
- Keep each item short and lowercase except names (Parmesan): amount first, then the ingredient, plus a key detail only when it matters for buying (boneless, low-sodium).
- Leave off staples and anything the family says is already in the kitchen; list in leftOff only the ones these recipes use. If a recipe needs a lot of a staple (2 cups of olive oil), keep it on the list.
- Leave off anything already bought (checked off on the list), whatever it's called there ("3 yellow onions" bought covers the onions).
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
  /** it worked, with a loose end the person should know about */
  warning?: string;
}

/** An item reduced to what it is, without amounts or the "(Mon, Thu)" note, so "3 lemons (Thu)" matches "2 lemons". */
const core = (s: string) =>
  s
    .replace(/\s*\([^)]*\)\s*$/, "")
    .toLowerCase()
    .replace(/[\d½¼¾⅓⅔⅛.,/()-]+/g, " ")
    .replace(/\b(cups?|tbsps?|tablespoons?|tsps?|teaspoons?|lbs?|pounds?|oz|ounces?|g|kg|ml|cans?|bunch(es)?|heads?|cloves?|packages?|large|medium|small|about)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const FRACTIONS: Record<string, number> = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3, "⅛": 0.125 };
// sold by weight or volume, so "1.5 lb" is a fine thing to ask for at the counter
const MEASURED = /^(lbs?|pounds?|oz|ounces?|kg|g|grams?|cups?|pints?|quarts?|gallons?|liters?|l|ml)\b/i;

/** "2.25 lemons" or "1 1/2 onions" is a whole number of them at the store: "3 lemons", "2 onions". */
function wholeCount(text: string): string {
  const m = text.match(/^(\d+(?:\.\d+)?(?:\s+\d+\/\d+|\s*[½¼¾⅓⅔⅛])?|\d+\/\d+|[½¼¾⅓⅔⅛])\s+(.*)$/);
  if (!m || MEASURED.test(m[2])) return text;
  const n = m[1]
    .trim()
    .split(/\s+|(?=[½¼¾⅓⅔⅛])/)
    .reduce((sum, part) => {
      if (FRACTIONS[part]) return sum + FRACTIONS[part];
      const [a, b] = part.split("/").map(Number);
      return sum + (b ? a / b : a);
    }, 0);
  return Number.isInteger(n) || !n ? text : `${Math.ceil(n)} ${m[2]}`;
}

/** What's planned this week, with each dinner's ingredients from Mealie or its web page. */
async function dishesFor(start: string): Promise<{ dishes: Dish[]; missing: string[] }> {
  // a dinner with no recipe to read is "missing"; one whose recipe couldn't be reached right now is a reason to stop
  const unreachable: string[] = [];
  const week = await getWeek(start);
  const dishes: Dish[] = [];
  const missing: string[] = [];
  // dinners already behind us were shopped for (and eaten)
  const today = localDate();
  for (const n of week.nights) {
    if (!n.cooking || !n.title || n.date < today) continue;
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
      if (e instanceof NoRecipeError) missing.push(`${n.day} (${n.title})`);
      else unreachable.push(n.day);
    }
  }
  // a short list that quietly skips Tuesday is worse than asking to try again
  if (unreachable.length) {
    throw new UserError(`Couldn't read the recipe for ${unreachable.join(", ")} right now. Mealie or the recipe's site didn't answer. Try again in a minute.`);
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
    throw new Error(
      missing.length ? `None of the dinners left this week have a recipe to shop from (${missing.join(", ")}).` : "No dinners left to shop for this week.",
    );
  }
  const people = householdSize();
  const pantry = listPantry().map((p) => p.item);

  const d = getDb();
  const prevListId = (d.prepare("select list_id from grocery_lists where week_start = ?").get(start) as { list_id: string } | undefined)?.list_id;
  // what's already bought, so the model doesn't put it back under another name
  const bought = ((prevListId && (await getShoppingList(prevListId))) || { items: [] }).items.filter((i) => i.checked).map((i) => i.note);
  const menu = dishes
    .map(
      (d) =>
        `${d.day}: ${d.title} (recipe makes: ${d.servings ?? "unknown"})${d.note ? `\nNote: ${d.note}` : ""}\n${d.ingredients.map((i) => `- ${i}`).join("\n")}`,
    )
    .join("\n\n");
  const t0 = Date.now();
  const out = await llmJson<{ items?: unknown; leftOff?: unknown }>(
    PROMPT,
    `People eating: ${people}\nStaples: ${STAPLES}\nAlready in the kitchen: ${pantry.join(", ") || "(nothing listed)"}\nAlready bought: ${bought.join(", ") || "(nothing yet)"}\n\n${menu}`,
  );
  const seen = new Set<string>();
  const items = (Array.isArray(out.items) ? out.items : [])
    .map((i) => i as { text?: unknown; aisle?: unknown; for?: unknown })
    .filter((i) => typeof i.text === "string" && i.text.trim())
    // the same thing twice is one line too many
    .filter((i) => {
      const k = core(String(i.text));
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 120)
    .map((i) => {
      const days = Array.isArray(i.for) ? i.for.filter((x): x is string => typeof x === "string").slice(0, 7) : [];
      const aisle = AISLES.find((a) => a.toLowerCase() === String(i.aisle ?? "").toLowerCase()) ?? "Other";
      return { text: `${wholeCount(String(i.text).trim()).slice(0, 120)}${days.length ? ` (${days.join(", ")})` : ""}`, aisle };
    });
  console.log(`[groceries] ${dishes.length} dinners -> ${items.length} items in ${Math.round((Date.now() - t0) / 1000)}s`);
  if (!items.length) throw new UserError("Couldn't put a list together this time. Try again.");
  // only staples these recipes call for; "left off: ice, water" says nothing
  const used = dishes.flatMap((x) => x.ingredients).join("\n").toLowerCase();
  const boughtCores = new Set(bought.map(core));
  const leftOff = (Array.isArray(out.leftOff) ? out.leftOff : [])
    .filter((x): x is string => typeof x === "string" && !!x.trim() && !boughtCores.has(core(x)))
    .filter((x) => {
      const last = x.trim().toLowerCase().split(/\s+/).pop()!.replace(/[^a-z]/g, "");
      return !!last && new RegExp(`\\b${last}(e?s)?\\b`).test(used);
    })
    .slice(0, 30);

  // read the list again: people may have checked things off while the model worked
  const name = `Groceries for ${weekday(start)} ${start.slice(5)} to ${weekday(addDays(start, 6))} ${addDays(start, 6).slice(5)}`;
  const prev = d.prepare("select list_id, item_ids from grocery_lists where week_start = ?").get(start) as
    | { list_id: string; item_ids: string }
    | undefined;
  const save = (listId: string, ids: string[], count: number) =>
    d
      .prepare(
        `insert into grocery_lists (week_start, list_id, item_ids, item_count, created_by, updated_at) values (?, ?, ?, ?, ?, datetime('now'))
         on conflict(week_start) do update set list_id = excluded.list_id, item_ids = excluded.item_ids,
           item_count = excluded.item_count, created_by = excluded.created_by, updated_at = excluded.updated_at`,
      )
      .run(start, listId, JSON.stringify(ids), count, byUserId);
  let listId = prev?.list_id;
  let current = listId ? await getShoppingList(listId) : null;
  let ours = new Set<string>(prev && current ? JSON.parse(prev.item_ids) : []);
  if (!current) {
    listId = await createShoppingList(name);
    current = { name, items: [] };
    // remember it now, so a failure below reuses this list instead of making another
    save(listId, [], 0);
    ours = new Set();
  }
  const checked = current.items.filter((i) => i.checked);
  const checkedCores = new Set(checked.map((i) => core(i.note)));
  // already bought: don't put it back on the list
  const fresh = items.filter((i) => !checkedCores.has(core(i.text)));
  // new items go in first, so a failure leaves the old list as it was
  const last = Math.max(-1, ...current.items.map((i) => i.position));
  const ids = await addShoppingItems(listId!, fresh, last);
  const keptIds = checked.filter((i) => ours.has(i.id)).map((i) => i.id);
  save(listId!, [...ids, ...keptIds], fresh.length);
  // then the old unchecked ones come off (Mealie may have merged a new line into one of them, so keep those)
  const added = new Set(ids);
  const stale = current.items.filter((i) => ours.has(i.id) && !i.checked && !added.has(i.id)).map((i) => i.id);
  let cleanupFailed = false;
  try {
    await deleteShoppingItems(stale);
  } catch (e) {
    console.warn("[groceries] couldn't clear the old items:", e);
    save(listId!, [...ids, ...keptIds, ...stale], fresh.length);
    cleanupFailed = true;
  }
  logActivity(byUserId, `made the grocery list for the week of ${shortDate(start).slice(4)} (${fresh.length} items)`);
  return {
    listId: listId!,
    url: shoppingListUrl(listId!),
    name: current.name,
    count: fresh.length,
    leftOff,
    missing,
    kept: checked.length,
    warning: cleanupFailed ? "The old list's items are still there too; making it again will clear them." : undefined,
  };
}

/** The week's list this app made, read from Mealie. Null when there isn't one (or it was deleted there). */
export async function listFor(start: string) {
  const row = getDb().prepare("select list_id from grocery_lists where week_start = ?").get(weekStart(start)) as { list_id: string } | undefined;
  if (!row) return null;
  const list = await getShoppingList(row.list_id);
  if (!list) return null;
  const labels = await labelNames();
  const order = (aisle: string) => {
    const i = AISLES.indexOf(aisle);
    return i < 0 ? AISLES.length : i;
  };
  const items = list.items
    .map((i) => ({ id: i.id, text: i.note, checked: i.checked, aisle: (i.labelId && labels.get(i.labelId)) || "Other", position: i.position }))
    .sort((a, b) => order(a.aisle) - order(b.aisle) || a.position - b.position);
  return { listId: row.list_id, name: list.name, url: shoppingListUrl(row.list_id), items };
}
