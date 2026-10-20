import { logActivity } from "./activity";
import { UserError, userMessage } from "./errors";
import { getDb, type User } from "./db";
import { addDays, localDate, shortDate, weekday, weekStart, zonedTime } from "./dates";
import { addTimelineEvent, markMade, rateRecipe } from "./mealie";
import { getWeek, type Night } from "./week";

export const VERDICTS = ["loved", "fine", "not_again", "skipped", "dismissed"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const VERDICT_WORDS: Record<Verdict, string> = {
  loved: "loved it",
  fine: "it was fine",
  not_again: "not again",
  skipped: "didn't end up making it",
  dismissed: "no answer",
};

// what each answer counts for in the recipe's Mealie rating
const STARS: Partial<Record<Verdict, number>> = { loved: 5, fine: 3, not_again: 1 };

export interface FeedbackRow {
  date: string;
  userId: number;
  name: string;
  verdict: Verdict;
  comment: string | null;
}

export function feedbackFor(dates: string[]): FeedbackRow[] {
  if (!dates.length) return [];
  return getDb()
    .prepare(
      `select f.date, f.user_id as userId, u.name, f.verdict, f.comment from feedback f join users u on u.id = f.user_id
       where f.date in (${dates.map(() => "?").join(",")}) order by f.date, u.id`,
    )
    .all(...dates) as FeedbackRow[];
}

/** Planned dinners from the last week, newest first, whether or not anyone has said how they went. */
async function recentDinners(days = 7): Promise<Night[]> {
  const today = localDate();
  // tonight's dinner counts once the evening is mostly over
  const lastDay = Date.now() >= zonedTime(today, 20).getTime() ? today : addDays(today, -1);
  const first = addDays(today, -days);
  const weeks: string[] = [];
  for (let w = weekStart(first); w <= lastDay; w = addDays(w, 7)) weeks.push(w);
  const nights = (await Promise.all(weeks.map((w) => getWeek(w)))).flatMap((w) => w.nights);
  return nights.filter((n) => n.date >= first && n.date <= lastDay && n.cooking && n.title).reverse();
}

/** The most recent dinner this person hasn't said anything about yet, if there is one. */
export async function nextToAsk(userId: number): Promise<Night | null> {
  const dinners = await recentDinners(4);
  const answered = new Set(feedbackFor(dinners.map((n) => n.date)).filter((f) => f.userId === userId).map((f) => f.date));
  return dinners.find((n) => !answered.has(n.date)) ?? null;
}

/** Recent dinners and what people said, for Sal's planning. */
export async function recentFeedbackLines(): Promise<string[]> {
  const dinners = await recentDinners(14);
  const fb = feedbackFor(dinners.map((n) => n.date)).filter((f) => f.verdict !== "dismissed");
  return dinners.map((n) => {
    const said = fb.filter((f) => f.date === n.date).map((f) => `${f.name}: ${VERDICT_WORDS[f.verdict]}${f.comment ? ` ("${f.comment}")` : ""}`);
    return `- ${weekday(n.date)} ${n.date}: ${n.title}${said.length ? ` -> ${said.join("; ")}` : " -> nobody has said yet"}`;
  });
}

/**
 * Save how a dinner went for one person. The first answer that says it was cooked marks the
 * recipe "made" in Mealie; every answer updates the recipe's rating and adds a note to its timeline.
 * Mealie trouble doesn't lose the answer: it's saved here first and the problem comes back as a warning.
 */
export async function recordFeedback(
  user: User,
  date: string,
  verdict: Verdict,
  comment?: string | null,
): Promise<{ title: string; warning?: string }> {
  const d = getDb();
  const night = (await getWeek(weekStart(date))).nights.find((n) => n.date === date);
  if (!night?.title) throw new UserError("Nothing was planned that night.");
  const note = comment?.trim().slice(0, 300) || null;
  d.prepare(
    `insert into feedback (date, user_id, verdict, comment) values (?, ?, ?, ?)
     on conflict(date, user_id) do update set verdict = excluded.verdict, comment = coalesce(excluded.comment, feedback.comment), created_at = datetime('now')`,
  ).run(date, user.id, verdict, note);
  if (verdict !== "dismissed") logActivity(user.id, `said ${night.title} on ${shortDate(date)}: ${VERDICT_WORDS[verdict]}${note ? ` ("${note}")` : ""}`);

  if (!night.recipeSlug || verdict === "dismissed") return { title: night.title };
  const when = zonedTime(date, 19);
  try {
    if (verdict !== "skipped") {
      const claimed = d.prepare("update nights set marked_made = 1 where date = ? and marked_made = 0").run(date);
      if (claimed.changes) {
        try {
          await markMade(night.recipeSlug, when);
        } catch (e) {
          // let the next answer try again
          d.prepare("update nights set marked_made = 0 where date = ?").run(date);
          throw e;
        }
      }
      const everyone = feedbackFor([date]).map((f) => STARS[f.verdict]).filter((n): n is number => n != null);
      if (everyone.length) await rateRecipe(night.recipeSlug, Math.round(everyone.reduce((a, b) => a + b, 0) / everyone.length));
      if (night.recipeId) {
        await addTimelineEvent(night.recipeId, `${user.name}: ${VERDICT_WORDS[verdict]}`, note ?? `Cooked on ${weekday(date, "long")}.`, when);
      }
    }
    return { title: night.title };
  } catch (e) {
    console.warn(`[feedback] Mealie update for ${date} failed:`, e);
    return { title: night.title, warning: `Saved here, but Mealie didn't take it: ${userMessage(e, "something went wrong on the way.", "feedback")}` };
  }
}
