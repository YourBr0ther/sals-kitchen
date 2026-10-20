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
  getDb().prepare("insert into activity (user_id, text) values (?, ?)").run(userId, text.slice(0, 300));
  // the log is a recent-history feed, not an archive
  getDb().prepare("delete from activity where id <= (select max(id) from activity) - 500").run();
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
