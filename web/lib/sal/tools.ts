import OpenAI from "openai";
import { applyProfileChange, canEditProfile, getDb, getUser, getUserByName, PROFILE_LISTS, type ProfileChange, type ProfileList, type User } from "../db";
import { addDays, isDate, localDate, weekday, weekStart } from "../dates";
import { findBySourceUrl, getRecipe, importRecipe, listMealPlans, searchRecipes } from "../mealie";
import { logActivity } from "../activity";
import { UserError, userMessage } from "../errors";
import { recordFeedback, VERDICT_WORDS, type Verdict } from "../feedback";
import { buildGroceryList, listFor } from "../groceries";
import { addMemory, deleteMemory, forgetMatching, WEB_TOOLS, windowRows } from "../memory";
import { changePantry } from "../pantry";
import { extractRecipe, NoRecipeError, type Recipe, recipeFromText } from "../recipe";
import { autoTag } from "../tagger";
import { webSearch } from "../web";
import { getWeek, updateNight } from "../week";
import { weekBlock } from "./prompt";

type Tool = OpenAI.Chat.Completions.ChatCompletionTool;

export const TOOLS: Tool[] = [
  {
    type: "function",
    function: {
      name: "search_recipes",
      description:
        "Search the family's Mealie recipe box by keyword (dish, ingredient, cuisine). An empty query lists recipes alphabetically.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_recipe",
      description: "Full details for one recipe in the box: ingredients, steps, time, notes.",
      parameters: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"] },
    },
  },
  {
    type: "function",
    function: {
      name: "recent_dinners",
      description: "Dinners from Mealie's meal plan over the past few weeks, to avoid repeats.",
      parameters: { type: "object", properties: { weeks: { type: "integer", minimum: 1, maximum: 8 } } },
    },
  },
  {
    type: "function",
    function: {
      name: "get_week",
      description: "The week ticket for any week: which nights are cooking nights, calendar conflicts, planned meals.",
      parameters: {
        type: "object",
        properties: { week_of: { type: "string", description: "Any date (YYYY-MM-DD) in the week. Defaults to this week." } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "plan_nights",
      description:
        "Fill in or change nights on the week ticket. This is a draft the family can see; nothing goes to Mealie until they tap Send. " +
        'To mark a night when nobody cooks (busy, eating out), set status "off". To put a dish on a night, set status "cooking" and title. ' +
        "Set title to null only to clear a dish and leave the night open.",
      parameters: {
        type: "object",
        properties: {
          nights: {
            type: "array",
            items: {
              type: "object",
              properties: {
                date: { type: "string", description: "YYYY-MM-DD" },
                status: { type: "string", enum: ["cooking", "off"], description: '"off" means nobody cooks that night' },
                title: { type: ["string", "null"], description: "Dish name as the family should see it" },
                recipe_slug: { type: "string", description: "Slug of a recipe in the box" },
                source_url: { type: "string", description: "Link for a web recipe that isn't in the box" },
                note: { type: "string", description: "Short note, e.g. 'double it for lunches'" },
              },
              required: ["date"],
            },
          },
        },
        required: ["nights"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for new recipes or cooking questions.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_link",
      description:
        "Read a web page. If it has a recipe, you get its ingredients and steps and importable=true. " +
        "If not, importable=false with a short excerpt of the page. Only offer to save recipes with importable=true.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
  },
  {
    type: "function",
    function: {
      name: "import_recipe_url",
      description:
        "Ask to save a web recipe into the Mealie recipe box. The page is read first; if it has no usable recipe you get an error " +
        "right away and no button is shown. Otherwise the person gets an approve button and it runs only if they tap it. " +
        "Optionally put it on a night of the week ticket once saved.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          title: { type: "string", description: "Recipe name, for the approve button" },
          plan_for: { type: "string", description: "YYYY-MM-DD to put it on after saving" },
        },
        required: ["url", "title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remember",
      description:
        "Save a lasting fact about the person you're talking to, private to them, for future conversations. " +
        "Use it for things that help plan meals later but aren't food likes or dislikes: schedule (\"works late Thursdays\"), " +
        "goals (\"cutting back on red meat\"), equipment (\"has an Instant Pot\"), skill, household routines. " +
        "Food likes, won't-eats, and allergies go in update_profile instead. Saved right away, no approval needed.",
      parameters: {
        type: "object",
        properties: { fact: { type: "string", description: "One short sentence about them, e.g. 'Works late on Thursdays.'" } },
        required: ["fact"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "forget",
      description: "Remove something you remember about the person you're talking to, when they say it's wrong or out of date.",
      parameters: {
        type: "object",
        properties: { about: { type: "string", description: "Words from the memory to remove, e.g. 'keto'" } },
        required: ["about"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_profile",
      description:
        "Ask to change someone's taste profile. The person gets an approve button. " +
        'Lists: "loves" (favorite dishes or ingredients), "nopes" (things they won\'t eat), "allergies", "notes" (habits, e.g. "vegetarian on weekdays"). ' +
        'Example: someone hates olives -> {action: "add", list: "nopes", item: "olives"}. ' +
        'Use "remove" only to take an item off a list because it\'s no longer true.',
      parameters: {
        type: "object",
        properties: {
          person: { type: "string", description: "Household member's name" },
          changes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                action: { type: "string", enum: ["add", "remove"] },
                list: { type: "string", enum: [...PROFILE_LISTS] },
                item: { type: "string" },
              },
              required: ["action", "list", "item"],
            },
          },
        },
        required: ["person", "changes"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_recipe_from_chat",
      description:
        "Ask to save a recipe the person sent in this chat, as a photo (recipe card, cookbook page, screenshot) or as pasted text, into the Mealie recipe box. " +
        "The app reads the recipe from their latest message that has one. If there's no complete recipe there, you get an error and no button is shown. " +
        "Otherwise they get an approve button.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "The recipe's name, if you can tell" },
          plan_for: { type: "string", description: "YYYY-MM-DD to put it on after saving" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "make_grocery_list",
      description:
        "Ask to write the week's grocery list into Mealie from the dinners on the ticket. The person gets an approve button. " +
        "The list is scaled to the household, combines ingredients across recipes, and leaves off staples and what's already in the kitchen. " +
        "Making it again replaces the old one, keeping anything already checked off.",
      parameters: {
        type: "object",
        properties: { week_of: { type: "string", description: "Any date (YYYY-MM-DD) in the week. Defaults to this week." } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_grocery_list",
      description: "Read the week's grocery list from Mealie: what's still to buy and what's already checked off.",
      parameters: {
        type: "object",
        properties: { week_of: { type: "string", description: "Any date (YYYY-MM-DD) in the week. Defaults to this week." } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_pantry",
      description:
        "Change the household's list of what's already in the kitchen (shared by everyone). Add things they say they have or just bought, " +
        "or that you see in a fridge or pantry photo; remove things they used up or ran out of. Items on it are left off grocery lists.",
      parameters: {
        type: "object",
        properties: {
          add: { type: "array", items: { type: "string" }, description: 'Short names, e.g. "spinach", "chicken thighs"' },
          remove: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "log_dinner",
      description:
        "Record how a planned dinner went for the person you're talking to, when they tell you. This rates the recipe in Mealie and marks it made.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "YYYY-MM-DD of the dinner" },
          verdict: { type: "string", enum: ["loved", "fine", "not_again", "skipped"], description: '"skipped" means they didn\'t end up making it' },
          comment: { type: "string", description: "What they said about it, in a few words" },
        },
        required: ["date", "verdict"],
      },
    },
  },
];

export const TOOL_LABELS: Record<string, string> = {
  search_recipes: "Digging through the recipe box",
  get_recipe: "Pulling the recipe card",
  recent_dinners: "Checking what you've had lately",
  get_week: "Looking at the week",
  plan_nights: "Writing it on the ticket",
  web_search: "Searching the web",
  read_link: "Reading the page",
  import_recipe_url: "Asking to save a recipe",
  update_profile: "Asking to update a profile",
  remember: "Making a note",
  forget: "Crossing that out",
  save_recipe_from_chat: "Reading the recipe",
  make_grocery_list: "Asking to make the grocery list",
  update_pantry: "Updating the kitchen list",
  get_grocery_list: "Checking the grocery list",
  log_dinner: "Writing down how it went",
};

export interface ToolContext {
  user: User;
  /** pending action ids created during this turn */
  actions: number[];
  /** what the client should refresh after the turn */
  changed: Set<"week" | "profiles" | "pantry">;
  /** facts saved to this person's memory during the turn */
  remembered: string[];
  /** web text is somewhere in what the model can see; memory changes then need the person's approval */
  webInView: boolean;
}

function createAction(ctx: ToolContext, kind: string, args: unknown, summary: string) {
  const r = getDb()
    .prepare("insert into pending_actions (user_id, kind, args, summary) values (?, ?, ?, ?)")
    .run(ctx.user.id, kind, JSON.stringify(args), summary);
  const id = Number(r.lastInsertRowid);
  ctx.actions.push(id);
  return id;
}

function describeChange(name: string, change: ProfileChange): string {
  const words: Record<string, string> = { loves: "favorites", nopes: "won't-eat list", allergies: "allergies", notes: "notes" };
  const parts: string[] = [];
  for (const l of PROFILE_LISTS) {
    if (change.add?.[l]?.length) parts.push(`add ${change.add[l]!.join(", ")} to ${name}'s ${words[l]}`);
    if (change.remove?.[l]?.length) parts.push(`remove ${change.remove[l]!.join(", ")} from ${name}'s ${words[l]}`);
  }
  const s = parts.join("; ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

type Args = Record<string, unknown>;

/**
 * The recipe text from the person's latest message that has one: a photo's transcription
 * or a long pasted message. Only their own messages, never web pages, are read.
 */
function recipeSourceText(userId: number): string | null {
  const users = windowRows(userId).filter((r) => r.role === "user").slice(-6).reverse();
  for (const r of users) {
    const notes = (JSON.parse(r.payload) as { photoNotes?: string[] }).photoNotes ?? [];
    const text = [r.content, ...notes].join("\n\n").trim();
    if (notes.length || r.content.length >= 150) return text;
  }
  return null;
}

function withHeadings(lines: string[], headings?: { at: number; title: string }[]): string[] {
  if (!headings?.length) return lines;
  const out: string[] = [];
  lines.forEach((line, i) => {
    for (const h of headings) if (h.at === i) out.push(`[${h.title}]`);
    out.push(line);
  });
  return out;
}

export async function runTool(name: string, args: Args, ctx: ToolContext): Promise<unknown> {
  if (WEB_TOOLS.has(name)) ctx.webInView = true;
  switch (name) {
    case "search_recipes":
      return searchRecipes(String(args.query ?? ""));
    case "get_recipe":
      return getRecipe(String(args.slug));
    case "recent_dinners": {
      const weeks = Math.min(Math.max(Number(args.weeks) || 3, 1), 8);
      const end = localDate();
      const plans = await listMealPlans(addDays(end, -7 * weeks), end);
      return plans
        .filter((p) => p.entryType === "dinner")
        .map((p) => ({ date: p.date, dinner: p.recipe?.name ?? p.title, slug: p.recipe?.slug ?? null }));
    }
    case "get_week":
      return weekBlock(await getWeek(isDate(args.week_of) ? weekStart(args.week_of) : undefined));
    case "plan_nights": {
      const nights = Array.isArray(args.nights) ? (args.nights as Args[]) : [];
      const errors: string[] = [];
      for (const n of nights) {
        if (!isDate(n.date)) {
          errors.push(`bad date ${String(n.date)}`);
          continue;
        }
        try {
          await updateNight(
            {
              date: n.date,
              cooking: n.status === "off" ? false : n.status === "cooking" ? true : typeof n.cooking === "boolean" ? n.cooking : undefined,
              title: n.title === null ? null : typeof n.title === "string" ? n.title : undefined,
              recipeSlug: typeof n.recipe_slug === "string" ? n.recipe_slug : n.title === null ? null : undefined,
              // a new dish without a link shouldn't keep the old dish's link
              sourceUrl: typeof n.source_url === "string" ? n.source_url : n.title !== undefined ? null : undefined,
              note: typeof n.note === "string" ? n.note : n.title === null ? null : undefined,
            },
            ctx.user.id,
          );
        } catch (e) {
          errors.push(`${n.date}: ${(e as Error).message}`);
        }
      }
      ctx.changed.add("week");
      const first = nights.find((n) => isDate(n.date))?.date as string | undefined;
      const after = await getWeek(first);
      const done = nights.filter((n) => isDate(n.date) && !errors.some((e) => e.startsWith(`${n.date}:`)));
      if (done.length) {
        // read back what each night says now, so a recipe planned by slug logs its name
        const what = done.map((n) => {
          const night = after.nights.find((x) => x.date === n.date);
          const day = weekday(n.date as string);
          return !night?.cooking ? `${day} off` : night.title ? `${day}: ${night.title}` : `${day} open`;
        });
        logActivity(ctx.user.id, `planned with Sal: ${[...new Set(what)].join(", ")}`);
      }
      return { updated: nights.length - errors.length, errors, week: weekBlock(after) };
    }
    case "web_search":
      return webSearch(String(args.query));
    case "read_link": {
      const url = String(args.url ?? "");
      try {
        const r = await extractRecipe(url);
        const inBox = await findBySourceUrl(url).catch(() => undefined);
        return {
          url,
          importable: true,
          alreadyInBox: inBox ? { name: inBox.name, slug: inBox.slug } : null,
          name: r.name,
          description: r.description,
          servings: r.servings ?? null,
          makes: r.makes?.text ?? null,
          yield: r.recipeYield,
          prepTime: r.prepTime,
          cookTime: r.cookTime,
          totalTime: r.totalTime,
          // headings ("For the sauce") shown in place, so Sal reads the recipe the way the page lays it out
          ingredients: withHeadings(r.recipeIngredient, r.ingredientHeadings),
          steps: withHeadings(r.recipeInstructions, r.instructionHeadings),
          nutrition: r.nutrition && Object.keys(r.nutrition).length ? r.nutrition : null,
          notes: r.notes?.map((n) => (n.title ? `${n.title}: ${n.text}` : n.text)) ?? [],
        };
      } catch (e) {
        if (e instanceof NoRecipeError) return { url, importable: false, reason: e.message, title: e.title, excerpt: e.excerpt };
        return { url, importable: false, error: (e as Error).message };
      }
    }
    case "import_recipe_url": {
      const url = String(args.url ?? "");
      let recipe: Recipe;
      try {
        // read it now, so a page without a recipe fails here instead of after someone taps approve
        recipe = await extractRecipe(url);
      } catch (e) {
        return { error: `Can't save that one: ${(e as Error).message} Suggest a different recipe instead.` };
      }
      const existing = await findBySourceUrl(url).catch(() => undefined);
      const planFor = isDate(args.plan_for) ? args.plan_for : null;
      if (existing) {
        if (planFor) {
          await updateNight({ date: planFor, recipeSlug: existing.slug }, ctx.user.id);
          ctx.changed.add("week");
        }
        return { alreadyInBox: { name: existing.name, slug: existing.slug }, plannedFor: planFor };
      }
      const host = new URL(url).hostname.replace(/^www\./, "");
      const id = createAction(ctx, "import_recipe_url", { url, recipe, planFor }, `Save "${recipe.name}" from ${host} to the recipe box`);
      return { status: "waiting for approval", actionId: id, name: recipe.name };
    }
    case "remember": {
      const fact = String(args.fact ?? "").trim().replace(/\s+/g, " ").slice(0, 200);
      if (fact.length < 3) return { error: "Too short to save." };
      // web text in view could be trying to plant a lasting "fact": ask the person instead of saving silently
      if (ctx.webInView) {
        const id = createAction(ctx, "remember", { fact }, `Remember: "${fact}"`);
        return { status: "waiting for approval", actionId: id };
      }
      const saved = addMemory(ctx.user.id, fact, "chat");
      if (saved) ctx.remembered.push(saved);
      return saved ? { remembered: saved } : { note: "Already remembered." };
    }
    case "forget": {
      const about = String(args.about ?? "").trim().slice(0, 200);
      if (ctx.webInView) {
        const matches = forgetMatching(ctx.user.id, about, true);
        if (!matches.length) return { note: "Nothing matched; tell them what you do remember instead." };
        // approval deletes exactly these, not whatever matches later
        const id = createAction(ctx, "forget", { ids: matches.map((m) => m.id) }, `Forget: "${matches.map((m) => m.text).join('", "')}"`);
        return { status: "waiting for approval", actionId: id };
      }
      const removed = forgetMatching(ctx.user.id, about).map((m) => m.text);
      return removed.length ? { forgot: removed } : { note: "Nothing matched; tell them what you do remember instead." };
    }
    case "update_profile": {
      const target = getUserByName(String(args.person ?? ""));
      if (!target) return { error: `No one named ${String(args.person)} in the household.` };
      if (!canEditProfile(ctx.user, target)) {
        return { error: `${ctx.user.name} can't change ${target.name}'s profile. Only ${target.name} can.` };
      }
      const change: ProfileChange = { add: {}, remove: {} };
      for (const c of Array.isArray(args.changes) ? (args.changes as Args[]) : []) {
        const list = c.list as ProfileList;
        const item = String(c.item ?? "").trim();
        if (!PROFILE_LISTS.includes(list) || !item) continue;
        const side = c.action === "remove" ? change.remove! : change.add!;
        side[list] = [...(side[list] ?? []), item];
      }
      const summary = describeChange(target.name, change);
      if (!summary) return { error: "Nothing to change." };
      const id = createAction(ctx, "update_profile", { userId: target.id, change }, summary);
      return { status: "waiting for approval", actionId: id };
    }
    case "save_recipe_from_chat": {
      const source = recipeSourceText(ctx.user.id);
      if (!source) return { error: "There's no recipe in their recent messages. Ask them to paste it or send a photo of it." };
      let recipe: Recipe;
      try {
        recipe = await recipeFromText(source, typeof args.title === "string" ? args.title : "");
      } catch (e) {
        return { error: `Can't save that one: ${(e as Error).message} Ask for a clearer photo or the full text.` };
      }
      const planFor = isDate(args.plan_for) ? args.plan_for : null;
      const id = createAction(ctx, "import_recipe", { recipe, planFor }, `Save "${recipe.name}" to the recipe box`);
      return {
        status: "waiting for approval",
        actionId: id,
        name: recipe.name,
        ingredients: recipe.recipeIngredient.length,
        steps: recipe.recipeInstructions.length,
        // words the photo reader couldn't make out; mention them so the person can fix them in Mealie
        unclear: [...recipe.recipeIngredient, ...recipe.recipeInstructions].filter((l) => l.includes("[unclear]")),
      };
    }
    case "make_grocery_list": {
      const start = weekStart(isDate(args.week_of) ? args.week_of : localDate());
      const week = await getWeek(start);
      const planned = week.nights.filter((n) => n.cooking && n.title);
      if (!planned.length) return { error: "Nothing's planned that week yet, so there's nothing to shop for." };
      const id = createAction(ctx, "make_grocery_list", { start }, `Make the grocery list in Mealie for the week of ${start} (${planned.length} dinners)`);
      return { status: "waiting for approval", actionId: id };
    }
    case "get_grocery_list": {
      const list = await listFor(isDate(args.week_of) ? args.week_of : localDate());
      if (!list) return { note: "No grocery list has been made for that week. Offer make_grocery_list." };
      return {
        toBuy: list.items.filter((i) => !i.checked).map((i) => `${i.text} [${i.aisle}]`),
        alreadyBought: list.items.filter((i) => i.checked).map((i) => i.text),
      };
    }
    case "update_pantry": {
      const strings = (v: unknown) =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim().slice(0, 60)).filter(Boolean).slice(0, 30) : [];
      const add = strings(args.add);
      const remove = strings(args.remove);
      if (!add.length && !remove.length) return { error: "Nothing to change." };
      // web text in view could be steering this; let the person confirm it
      if (ctx.webInView) {
        const parts = [add.length && `add ${add.join(", ")}`, remove.length && `take off ${remove.join(", ")}`].filter(Boolean).join("; ");
        const id = createAction(ctx, "update_pantry", { add, remove }, `Kitchen list: ${parts}`);
        return { status: "waiting for approval", actionId: id };
      }
      const r = changePantry(ctx.user.id, add, remove);
      ctx.changed.add("pantry");
      return r;
    }
    case "log_dinner": {
      if (!isDate(args.date)) return { error: "Need the dinner's date." };
      const verdict = ["loved", "fine", "not_again", "skipped"].includes(String(args.verdict)) ? (args.verdict as Verdict) : null;
      if (!verdict) return { error: "verdict must be loved, fine, not_again, or skipped." };
      const comment = typeof args.comment === "string" ? args.comment.trim().slice(0, 300) : null;
      if (ctx.webInView) {
        const night = (await getWeek(weekStart(args.date))).nights.find((n) => n.date === args.date);
        if (!night?.title) return { error: "Nothing was planned that night." };
        const id = createAction(ctx, "log_dinner", { date: args.date, verdict, comment }, `Save how ${weekday(args.date)}'s ${night.title} went: ${VERDICT_WORDS[verdict]}`);
        return { status: "waiting for approval", actionId: id };
      }
      try {
        const r = await recordFeedback(ctx.user, args.date, verdict, comment);
        ctx.changed.add("week");
        return { saved: true, dinner: r.title, warning: r.warning };
      } catch (e) {
        return { error: (e as Error).message };
      }
    }
    default:
      return { error: `Unknown tool ${name}` };
  }
}

/** Runs an approved action. Returns a one-line result for the chat. */
export async function executeAction(
  actionId: number,
  user: User,
): Promise<{ ok: boolean; message: string; changed: ("week" | "profiles" | "pantry")[]; partial: boolean }> {
  const d = getDb();
  const a = d.prepare("select * from pending_actions where id = ? and user_id = ?").get(actionId, user.id) as
    | { id: number; kind: string; args: string; status: string; summary: string }
    | undefined;
  if (!a) throw new UserError("No such request.");
  // claim it before doing any work, so two taps (or two phones) can't both run it
  const claimed = d.prepare("update pending_actions set status = 'running' where id = ? and status = 'pending'").run(a.id);
  if (!claimed.changes) throw new UserError("Already handled.");
  const args = JSON.parse(a.args);
  try {
    let message: string;
    const changed: ("week" | "profiles" | "pantry")[] = [];
    // it worked, but part of it didn't; Sal follows up so the person hears which part
    let partial = false;
    if (a.kind === "import_recipe_url" || a.kind === "import_recipe") {
      // save exactly what was read when Sal asked; older requests only stored the URL
      const recipe: Recipe = args.recipe ?? (await extractRecipe(args.url));
      const { recipe: r, existed } = await importRecipe(recipe);
      message = existed ? `"${r.name}" was already in the recipe box (slug ${r.slug}).` : `Saved "${r.name}" to the recipe box (slug ${r.slug}).`;
      if (!existed) {
        logActivity(user.id, `saved ${r.name} to the recipe box`);
        // filing it is nice to have; a hiccup or a slow answer shouldn't hold up or undo the save
        const filed = await Promise.race([
          autoTag(r.slug, recipe),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 45_000)),
        ]).catch((e) => {
          console.warn(`[tagger] ${r.slug}:`, e);
          return null;
        });
        if (filed?.tags.length) message += ` Tagged ${filed.tags.join(", ")}.`;
        else if (!filed) message += " Couldn't tag it this time; it's saved without tags.";
      }
      if (args.planFor) {
        try {
          await updateNight({ date: args.planFor, recipeSlug: r.slug, title: r.name, sourceUrl: null }, user.id);
          message += ` Put it on ${args.planFor}.`;
          changed.push("week");
        } catch (e) {
          message += ` Couldn't put it on ${args.planFor}: ${userMessage(e, "something went wrong.", "plan saved recipe")}`;
          partial = true;
        }
      }
    } else if (a.kind === "make_grocery_list") {
      const r = await buildGroceryList(args.start, user.id);
      message = `Made the grocery list in Mealie: ${r.count} items (${r.url}).`;
      if (r.leftOff.length) message += ` Left off: ${r.leftOff.join(", ")}.`;
      if (r.missing.length) {
        message += ` No recipe to shop from for ${r.missing.join(", ")}.`;
        partial = true;
      }
      if (r.warning) {
        message += ` ${r.warning}`;
        partial = true;
      }
      changed.push("week");
    } else if (a.kind === "update_pantry") {
      const r = changePantry(user.id, args.add ?? [], args.remove ?? []);
      message = [
        r.added.length && `Added ${r.added.join(", ")} to the kitchen list.`,
        r.removed.length && `Took ${r.removed.join(", ")} off it.`,
        r.full && "The kitchen list is full (150 things). Take some off first.",
      ]
        .filter(Boolean)
        .join(" ") || "The kitchen list already looked like that.";
      partial = r.full;
      changed.push("pantry");
    } else if (a.kind === "log_dinner") {
      const r = await recordFeedback(user, args.date, args.verdict, args.comment);
      message = `Saved how ${r.title} went.${r.warning ? ` ${r.warning}` : ""}`;
      partial = Boolean(r.warning);
      changed.push("week");
    } else if (a.kind === "remember") {
      const saved = addMemory(user.id, String(args.fact), "chat");
      message = saved ? `Sal will remember: ${saved}` : "Sal already remembered that.";
    } else if (a.kind === "forget") {
      const ids = Array.isArray(args.ids) ? (args.ids as unknown[]).map(Number) : [];
      const removed = ids.filter((id) => deleteMemory(user.id, id)).length;
      message = removed ? `Sal forgot ${removed === 1 ? "that" : `${removed} things`}.` : "Nothing left to forget.";
    } else if (a.kind === "update_profile") {
      const target = getUser(args.userId);
      if (!target || !canEditProfile(user, target)) throw new UserError("Not allowed to change that profile.");
      applyProfileChange(target.id, args.change, user.id, "chat");
      message = `${a.summary}. Done.`;
      changed.push("profiles");
    } else {
      throw new Error(`Unknown action ${a.kind}`);
    }
    d.prepare("update pending_actions set status = 'approved', result = ? where id = ?").run(message, a.id);
    return { ok: true, message, changed, partial };
  } catch (e) {
    const message = userMessage(e, "Something went wrong doing that. Try again.", `action ${a.kind}`);
    d.prepare("update pending_actions set status = 'failed', result = ? where id = ?").run(message, a.id);
    return { ok: false, message, changed: [], partial: false };
  }
}

export function declineAction(actionId: number, user: User) {
  const r = getDb()
    .prepare("update pending_actions set status = 'declined' where id = ? and user_id = ? and status = 'pending'")
    .run(actionId, user.id);
  if (!r.changes) throw new UserError("Already handled.");
  const a = getDb().prepare("select summary from pending_actions where id = ?").get(actionId) as { summary: string };
  return a.summary;
}
