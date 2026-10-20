import { logActivity } from "./activity";
import { getDb } from "./db";

export interface PantryItem {
  id: number;
  item: string;
}

export function listPantry(): PantryItem[] {
  return getDb().prepare("select id, item from pantry order by item collate nocase").all() as PantryItem[];
}

const MAX_ITEMS = 150;

/** Add and remove items in one go. Returns what actually changed. */
export function changePantry(userId: number, add: string[], remove: string[]): { added: string[]; removed: string[] } {
  const d = getDb();
  const added: string[] = [];
  const removed: string[] = [];
  d.transaction(() => {
    for (const raw of remove) {
      const item = raw.trim();
      if (item && d.prepare("delete from pantry where item = ?").run(item).changes) removed.push(item);
    }
    for (const raw of add) {
      const item = raw.trim().replace(/\s+/g, " ").slice(0, 60);
      if (!item) continue;
      const count = (d.prepare("select count(*) as n from pantry").get() as { n: number }).n;
      if (count >= MAX_ITEMS) break;
      if (d.prepare("insert or ignore into pantry (item, added_by) values (?, ?)").run(item, userId).changes) added.push(item);
    }
  })();
  if (added.length) logActivity(userId, `added to the kitchen: ${added.join(", ")}`);
  if (removed.length) logActivity(userId, `used up: ${removed.join(", ")}`);
  return { added, removed };
}
