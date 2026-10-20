import { getDb } from "./db";

export interface Activity {
  id: number;
  userId: number | null;
  name: string | null;
  text: string;
  createdAt: string;
}

/** Note something one person did that the rest of the household should see ("planned Tue: Tacos"). */
export function logActivity(userId: number | null, text: string) {
  // the log is a nicety; it must never turn a finished action into a failed one
  try {
    // names can come from web pages: one line, no control characters
    const clean = text.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 300);
    getDb().prepare("insert into activity (user_id, text) values (?, ?)").run(userId, clean);
    // a recent-history feed, not an archive
    getDb().prepare("delete from activity where id <= (select max(id) from activity) - 500").run();
  } catch (e) {
    console.warn("[activity] couldn't log:", e);
  }
}

export function recentActivity(limit = 20): Activity[] {
  return (
    getDb()
      .prepare(
        `select a.id, a.user_id as userId, u.name, a.text, a.created_at as createdAt
         from activity a left join users u on u.id = a.user_id order by a.id desc limit ?`,
      )
      .all(limit) as Activity[]
  ).reverse();
}
