import { currentUser, unauthorized } from "@/lib/auth";
import { addMessage } from "@/lib/chat";
import { isDate } from "@/lib/dates";
import { buildGroceryList } from "@/lib/groceries";
import { guarded, readJson } from "@/lib/http";
import { userMessage } from "@/lib/errors";
import { getWeek } from "@/lib/week";
import { getDb } from "@/lib/db";
import { weekStart } from "@/lib/dates";
import { AISLES, getShoppingList, labelNames, setShoppingItemChecked, shoppingListUrl } from "@/lib/mealie";
import type { NextRequest } from "next/server";

/** The week's list this app made, read from Mealie. Null when there isn't one (or it was deleted there). */
async function listFor(start: string) {
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

/** The grocery list for the store: everyone in the household shares it. */
export const GET = guarded("week/groceries GET", async function GET(req: NextRequest) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const start = req.nextUrl.searchParams.get("start");
  if (!isDate(start)) return Response.json({ error: "Bad week." }, { status: 400 });
  try {
    return Response.json({ list: await listFor(start) });
  } catch (e) {
    return Response.json({ error: userMessage(e, "Couldn't load the grocery list. Try again.", "week/groceries GET") }, { status: 502 });
  }
});

/** Check an item off. Only items on a list this app made can be changed from here. */
export const PATCH = guarded("week/groceries PATCH", async function PATCH(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const parsed = await readJson<{ start?: unknown; itemId?: unknown; checked?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const { start, itemId, checked } = parsed.data;
  if (!isDate(start) || typeof itemId !== "string" || typeof checked !== "boolean") return Response.json({ error: "Bad request." }, { status: 400 });
  try {
    const list = await listFor(start);
    if (!list?.items.some((i) => i.id === itemId)) return Response.json({ error: "That item isn't on the list anymore.", list }, { status: 404 });
    await setShoppingItemChecked(itemId, checked);
    return Response.json({ list: await listFor(start) });
  } catch (e) {
    return Response.json({ error: userMessage(e, "Couldn't check that off. Try again.", "week/groceries PATCH") }, { status: 502 });
  }
});

/** Make (or remake) the week's grocery list in Mealie. */
export const POST = guarded("week/groceries POST", async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  if (user.role !== "adult") return Response.json({ error: "Only grown-ups can make the grocery list." }, { status: 403 });
  const parsed = await readJson<{ start?: string }>(req);
  if (!parsed.ok) return parsed.response;
  const { start } = parsed.data;
  if (!isDate(start)) return Response.json({ error: "Bad week." }, { status: 400 });
  try {
    const r = await buildGroceryList(start, user.id);
    addMessage(user.id, "event", `${user.name} made the grocery list for the week of ${start} (${r.count} items).`);
    return Response.json({ ...r, week: await getWeek(start) });
  } catch (e) {
    const message = userMessage(e, "Couldn't make the list. Try again.", "week/groceries");
    return Response.json({ error: message, week: await getWeek(start).catch(() => null) }, { status: 502 });
  }
});
