import { currentUser, unauthorized } from "@/lib/auth";
import { addMessage } from "@/lib/chat";
import { isDate, weekday } from "@/lib/dates";
import { nextToAsk, recordFeedback, VERDICT_WORDS, VERDICTS, type Verdict } from "@/lib/feedback";
import { userMessage } from "@/lib/errors";
import { guarded, readJson } from "@/lib/http";

/** The dinner to ask this person about, if any. */
export const GET = guarded("feedback GET", async function GET() {
  const user = await currentUser();
  if (!user) return unauthorized();
  const n = await nextToAsk(user.id);
  return Response.json({ ask: n ? { date: n.date, day: weekday(n.date, "long"), title: n.title } : null });
});

/** One tap from the "how was it?" card. Sal hears about it in the chat and can follow up. */
export const POST = guarded("feedback POST", async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const parsed = await readJson<{ date?: unknown; verdict?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const { date, verdict } = parsed.data;
  if (!isDate(date) || !VERDICTS.includes(verdict as Verdict)) return Response.json({ error: "Bad answer." }, { status: 400 });
  try {
    const r = await recordFeedback(user, date, verdict as Verdict);
    let event: number | null = null;
    if (verdict !== "dismissed") {
      // Sal relays any Mealie trouble, since the chat moves on right after this
      const trouble = r.warning ? ` ${r.warning}` : "";
      event = addMessage(user.id, "event", `${user.name} said ${weekday(date, "long")}'s ${r.title}: ${VERDICT_WORDS[verdict as Verdict]}.${trouble}`);
    }
    return Response.json({ ok: true, event, warning: r.warning ?? null });
  } catch (e) {
    return Response.json({ error: userMessage(e, "Couldn't save that. Try again.", "feedback POST") }, { status: 400 });
  }
});
