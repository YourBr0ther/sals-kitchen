import { guarded, readJson } from "@/lib/http";
import type { NextRequest } from "next/server";
import { currentUser, unauthorized } from "@/lib/auth";
import { logActivity } from "@/lib/activity";
import { isDate, weekday } from "@/lib/dates";
import { MealieError } from "@/lib/mealie";
import { getWeek, updateNight } from "@/lib/week";

export const GET = guarded("week GET", async function GET(req: NextRequest) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const start = req.nextUrl.searchParams.get("start");
  return Response.json(await getWeek(isDate(start) ? start : undefined));
});

/** Tap edits from the week ticket: flip a night on or off, or clear its meal. */
export const PATCH = guarded("week PATCH", async function PATCH(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const parsed = await readJson<{ date?: string; cooking?: boolean | null; clear?: boolean; title?: string }>(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  if (!isDate(body.date)) return Response.json({ error: "Bad date." }, { status: 400 });
  try {
    if (body.clear) {
      await updateNight({ date: body.date, title: null, recipeSlug: null, sourceUrl: null, note: null }, user.id);
    } else if (typeof body.title === "string") {
      await updateNight({ date: body.date, title: body.title.slice(0, 120), sourceUrl: null }, user.id);
    }
    if (body.cooking !== undefined) await updateNight({ date: body.date, cooking: body.cooking }, user.id);
    const day = weekday(body.date);
    if (body.clear) logActivity(user.id, `cleared ${day} ${body.date}`);
    else if (typeof body.title === "string") logActivity(user.id, `put ${body.title.slice(0, 120)} on ${day} ${body.date}`);
    if (body.cooking !== undefined) logActivity(user.id, `marked ${day} ${body.date} as ${body.cooking ? "a cooking night" : "no cooking"}`);
  } catch (e) {
    console.warn("[week PATCH]", e);
    const message = e instanceof MealieError ? e.message : "Couldn't change that night. Try again.";
    return Response.json({ error: message, week: await getWeek(body.date).catch(() => null) }, { status: 400 });
  }
  return Response.json(await getWeek(body.date));
});
