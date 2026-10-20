import { currentUser, unauthorized } from "@/lib/auth";
import { addMessage } from "@/lib/chat";
import { isDate } from "@/lib/dates";
import { buildGroceryList } from "@/lib/groceries";
import { guarded, readJson } from "@/lib/http";
import { describeLlmError } from "@/lib/sal/agent";
import OpenAI from "openai";
import { getWeek } from "@/lib/week";

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
    console.warn("[week/groceries]", e);
    // our own errors are written for people; the AI service's need translating
    const message = e instanceof OpenAI.APIError ? describeLlmError(e).message : e instanceof Error ? e.message : "Couldn't make the list. Try again.";
    return Response.json({ error: message, week: await getWeek(start).catch(() => null) }, { status: 502 });
  }
});
