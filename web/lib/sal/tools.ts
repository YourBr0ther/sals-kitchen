import type OpenAI from "openai";
import { applyProfileChange, canEditProfile, getDb, getUser, getUserByName, PROFILE_LISTS, type ProfileChange, type ProfileList, type User } from "../db";
import { addDays, isDate, localDate, weekStart } from "../dates";
import { getRecipe, importRecipeFromUrl, listMealPlans, searchRecipes } from "../mealie";
import { readPage, webSearch } from "../web";
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
      description: "Read a web page. Recipe pages come back as structured ingredients and steps.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
  },
  {
    type: "function",
    function: {
      name: "import_recipe_url",
      description:
        "Ask to save a web recipe into the Mealie recipe box. The person gets an approve button; it runs only if they tap it. " +
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
};

export interface ToolContext {
  user: User;
  /** pending action ids created during this turn */
  actions: number[];
  /** what the client should refresh after the turn */
  changed: Set<"week" | "profiles">;
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

export async function runTool(name: string, args: Args, ctx: ToolContext): Promise<unknown> {
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
      return { updated: nights.length - errors.length, errors, week: weekBlock(await getWeek(first)) };
    }
    case "web_search":
      return webSearch(String(args.query));
    case "read_link":
      return readPage(String(args.url));
    case "import_recipe_url": {
      const url = String(args.url ?? "");
      if (!/^https?:\/\//.test(url)) return { error: "That isn't a web link." };
      const planFor = isDate(args.plan_for) ? args.plan_for : null;
      const title = String(args.title ?? url);
      const id = createAction(ctx, "import_recipe_url", { url, title, planFor }, `Save "${title}" to the recipe box`);
      return { status: "waiting for approval", actionId: id };
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
    default:
      return { error: `Unknown tool ${name}` };
  }
}

/** Runs an approved action. Returns a one-line result for the chat. */
export async function executeAction(actionId: number, user: User): Promise<{ ok: boolean; message: string; changed: ("week" | "profiles")[] }> {
  const d = getDb();
  const a = d.prepare("select * from pending_actions where id = ? and user_id = ?").get(actionId, user.id) as
    | { id: number; kind: string; args: string; status: string; summary: string }
    | undefined;
  if (!a) throw new Error("No such request.");
  if (a.status !== "pending") throw new Error("Already handled.");
  const args = JSON.parse(a.args);
  try {
    let message: string;
    const changed: ("week" | "profiles")[] = [];
    if (a.kind === "import_recipe_url") {
      const r = await importRecipeFromUrl(args.url);
      message = `Saved "${r.name}" to the recipe box (slug ${r.slug}).`;
      if (args.planFor) {
        await updateNight({ date: args.planFor, recipeSlug: r.slug, title: r.name, sourceUrl: null }, user.id);
        message += ` Put it on ${args.planFor}.`;
        changed.push("week");
      }
    } else if (a.kind === "update_profile") {
      const target = getUser(args.userId);
      if (!target || !canEditProfile(user, target)) throw new Error("Not allowed to change that profile.");
      applyProfileChange(target.id, args.change, user.id, "chat");
      message = `${a.summary}. Done.`;
      changed.push("profiles");
    } else {
      throw new Error(`Unknown action ${a.kind}`);
    }
    d.prepare("update pending_actions set status = 'approved', result = ? where id = ?").run(message, a.id);
    return { ok: true, message, changed };
  } catch (e) {
    const message = (e as Error).message;
    d.prepare("update pending_actions set status = 'failed', result = ? where id = ?").run(message, a.id);
    return { ok: false, message, changed: [] };
  }
}

export function declineAction(actionId: number, user: User) {
  const r = getDb()
    .prepare("update pending_actions set status = 'declined' where id = ? and user_id = ? and status = 'pending'")
    .run(actionId, user.id);
  if (!r.changes) throw new Error("Already handled.");
  const a = getDb().prepare("select summary from pending_actions where id = ?").get(actionId) as { summary: string };
  return a.summary;
}
