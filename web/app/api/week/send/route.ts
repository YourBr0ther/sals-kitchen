import { currentUser, unauthorized } from "@/lib/auth";
import { addMessage } from "@/lib/chat";
import { isDate } from "@/lib/dates";
import { getWeek, sendWeekToMealie } from "@/lib/week";

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  if (user.role !== "adult") return Response.json({ error: "Only grown-ups can send the week." }, { status: 403 });
  const { start } = (await req.json()) as { start?: string };
  if (!isDate(start)) return Response.json({ error: "Bad week." }, { status: 400 });
  try {
    const r = await sendWeekToMealie(start);
    addMessage(user.id, "event", `${user.name} sent the week of ${start} to Mealie (${r.sent} dinners).`);
    return Response.json({ ...r, week: await getWeek(start) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
