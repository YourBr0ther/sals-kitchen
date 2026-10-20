import { guarded, readJson } from "@/lib/http";
import { currentUser, unauthorized } from "@/lib/auth";
import { logActivity } from "@/lib/activity";
import { addMessage } from "@/lib/chat";
import { isDate } from "@/lib/dates";
import { MealieError } from "@/lib/mealie";
import { getWeek, sendWeekToMealie } from "@/lib/week";

export const POST = guarded("week/send POST", async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  if (user.role !== "adult") return Response.json({ error: "Only grown-ups can send the week." }, { status: 403 });
  const parsed = await readJson<{ start?: string }>(req);
  if (!parsed.ok) return parsed.response;
  const { start } = parsed.data;
  if (!isDate(start)) return Response.json({ error: "Bad week." }, { status: 400 });
  try {
    const r = await sendWeekToMealie(start);
    addMessage(user.id, "event", `${user.name} sent the week of ${start} to Mealie (${r.sent} dinners).`);
    logActivity(user.id, `sent the week of ${start} to Mealie (${r.sent} dinners)`);
    return Response.json({ ...r, week: await getWeek(start) });
  } catch (e) {
    console.error("[week/send]", e);
    // part of the week may have gone through; send the ticket back so it shows what did
    const message = e instanceof MealieError ? e.message : "Couldn't finish sending the week. Try again.";
    return Response.json({ error: `${message} Some nights may not have gone through yet.`, week: await getWeek(start).catch(() => null) }, { status: 502 });
  }
});
