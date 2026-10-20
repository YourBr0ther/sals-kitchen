import webpush, { WebPushError, type PushSubscription } from "web-push";
import { config } from "./config";
import { getDb } from "./db";

export const pushConfigured = () => Boolean(config.push.publicKey && config.push.privateKey);

export interface PushMessage {
  title: string;
  body: string;
  /** where tapping the notification opens, e.g. "/?tab=week" */
  url: string;
  /** a newer notification with the same tag replaces the older one on the phone */
  tag: string;
}

/** Store a phone's subscription for this person. A phone that changes hands moves to the new person. */
export function saveSubscription(userId: number, sub: PushSubscription) {
  getDb()
    .prepare(
      `insert into push_subscriptions (endpoint, user_id, keys) values (?, ?, ?)
       on conflict(endpoint) do update set user_id = excluded.user_id, keys = excluded.keys`,
    )
    .run(sub.endpoint, userId, JSON.stringify({ p256dh: sub.keys.p256dh, auth: sub.keys.auth }));
}

export function removeSubscription(endpoint: string, userId: number): boolean {
  return getDb().prepare("delete from push_subscriptions where endpoint = ? and user_id = ?").run(endpoint, userId).changes > 0;
}

export function usersWithSubscriptions(): number[] {
  return (getDb().prepare("select distinct user_id from push_subscriptions").all() as { user_id: number }[]).map((r) => r.user_id);
}

export interface SendResult {
  /** how many of this person's phones the push service accepted it for */
  sent: number;
  /** subscriptions the push service said are gone, now deleted */
  removed: number;
  failed: number;
  /** the push service's status code for each phone, in send order */
  statuses: number[];
}

// a dinner heads-up that arrives hours late is worse than none
const TTL_SECONDS = 4 * 3600;

/** Send to every phone this person has turned reminders on for. Never throws. */
// Browsers' push services. Only these may be saved as endpoints, so a sign-up can't point
// the server at an arbitrary address (an internal one, say) and have it send requests there.
const PUSH_HOSTS = ["fcm.googleapis.com", "android.googleapis.com", "web.push.apple.com", "updates.push.services.mozilla.com"];
const PUSH_SUFFIXES = [".push.apple.com", ".push.services.mozilla.com", ".notify.windows.com"];

export function isPushEndpoint(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.port || u.username || u.password) return false;
    const host = u.hostname.toLowerCase();
    return PUSH_HOSTS.includes(host) || PUSH_SUFFIXES.some((s) => host.endsWith(s));
  } catch {
    return false;
  }
}

export async function sendToUser(userId: number, msg: PushMessage): Promise<SendResult> {
  const result: SendResult = { sent: 0, removed: 0, failed: 0, statuses: [] };
  if (!pushConfigured()) return result;
  const rows = getDb().prepare("select endpoint, keys from push_subscriptions where user_id = ?").all(userId) as {
    endpoint: string;
    keys: string;
  }[];
  const payload = JSON.stringify(msg);
  const options = {
    TTL: TTL_SECONDS,
    vapidDetails: { subject: config.push.subject, publicKey: config.push.publicKey, privateKey: config.push.privateKey },
    timeout: 15_000,
  };
  await Promise.all(
    rows.map(async (r) => {
      // rows saved before the allowlist existed get the same check
      if (!isPushEndpoint(r.endpoint)) {
        getDb().prepare("delete from push_subscriptions where endpoint = ?").run(r.endpoint);
        result.removed++;
        return;
      }
      try {
        const res = await webpush.sendNotification({ endpoint: r.endpoint, keys: JSON.parse(r.keys) }, payload, options);
        result.sent++;
        result.statuses.push(res.statusCode);
      } catch (e) {
        const status = e instanceof WebPushError ? e.statusCode : 0;
        result.statuses.push(status);
        if (status === 404 || status === 410) {
          // the phone unsubscribed or the browser data was cleared
          getDb().prepare("delete from push_subscriptions where endpoint = ?").run(r.endpoint);
          result.removed++;
        } else {
          result.failed++;
          console.warn(`[push] send to user ${userId} failed${status ? ` (${status})` : ""}:`, e instanceof WebPushError ? e.body : e);
        }
      }
    }),
  );
  return result;
}
