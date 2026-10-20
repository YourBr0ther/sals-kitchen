import type { NextRequest } from "next/server";
import { currentUser, unauthorized } from "@/lib/auth";
import { isDate } from "@/lib/dates";
import { getWeek, updateNight } from "@/lib/week";

export async function GET(req: NextRequest) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const start = req.nextUrl.searchParams.get("start");
  return Response.json(await getWeek(isDate(start) ? start : undefined));
}

/** Tap edits from the week ticket: flip a night on or off, or clear its meal. */
export async function PATCH(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const body = (await req.json()) as { date?: string; cooking?: boolean | null; clear?: boolean; title?: string };
  if (!isDate(body.date)) return Response.json({ error: "Bad date." }, { status: 400 });
  try {
    if (body.clear) {
      await updateNight({ date: body.date, title: null, recipeSlug: null, sourceUrl: null, note: null }, user.id);
    } else if (typeof body.title === "string") {
      await updateNight({ date: body.date, title: body.title.slice(0, 120), sourceUrl: null }, user.id);
    }
    if (body.cooking !== undefined) await updateNight({ date: body.date, cooking: body.cooking }, user.id);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
  return Response.json(await getWeek(body.date));
}
