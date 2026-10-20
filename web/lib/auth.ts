import crypto from "node:crypto";
import { cookies } from "next/headers";
import { getDb, getPinHash, getUser, type User } from "./db";

export const SESSION_COOKIE = "sal_session";
const SESSION_DAYS = 180;

export function hashPin(pin: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pin, salt, 32);
  return `${salt.toString("hex")}:${key.toString("hex")}`;
}

function pinMatches(pin: string, stored: string): boolean {
  const [saltHex, keyHex] = stored.split(":");
  const key = crypto.scryptSync(pin, Buffer.from(saltHex, "hex"), 32);
  return crypto.timingSafeEqual(key, Buffer.from(keyHex, "hex"));
}

// Four-digit PINs are guessable, so every 5 misses locks the person out, and each
// lockout doubles (5 min, 10, 20, ...). Kept in the database so a restart doesn't reset it.
const TRIES_PER_LOCK = 5;
const FIRST_LOCK_MS = 5 * 60_000;
const MAX_LOCK_MS = 24 * 60 * 60_000;

type FailRow = { count: number; locks: number; locked_until: number };

export type LoginResult = { ok: true; token: string; maxAge: number } | { ok: false; error: string };

export function login(userId: number, pin: string): LoginResult {
  const checked = checkPin(userId, pin);
  if (!checked.ok) return checked;
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  getDb().prepare("insert into sessions (token, user_id, expires_at) values (?, ?, ?)").run(token, userId, expires);
  return { ok: true, token, maxAge: SESSION_DAYS * 86_400 };
}

/** Check a PIN, counting misses toward the lockout. Used for logging in and for changing a PIN. */
export function checkPin(userId: number, pin: string): { ok: true } | { ok: false; error: string } {
  const d = getDb();
  const f = d.prepare("select count, locks, locked_until from login_failures where user_id = ?").get(userId) as FailRow | undefined;
  if (f && f.locked_until > Date.now()) {
    const mins = Math.ceil((f.locked_until - Date.now()) / 60_000);
    return { ok: false, error: `Too many wrong PINs. Try again in ${mins} minute${mins === 1 ? "" : "s"}.` };
  }
  const stored = getPinHash(userId);
  if (!stored) return { ok: false, error: "This person can't log in." };
  if (!pinMatches(pin, stored)) {
    let count = (f?.count ?? 0) + 1;
    let locks = f?.locks ?? 0;
    let until = 0;
    if (count >= TRIES_PER_LOCK) {
      until = Date.now() + Math.min(FIRST_LOCK_MS * 2 ** locks, MAX_LOCK_MS);
      locks++;
      count = 0;
    }
    d.prepare(
      `insert into login_failures (user_id, count, locks, locked_until) values (?, ?, ?, ?)
       on conflict(user_id) do update set count = excluded.count, locks = excluded.locks, locked_until = excluded.locked_until`,
    ).run(userId, count, locks, until);
    console.warn(`[login] wrong PIN for user ${userId}${until ? `, locked until ${new Date(until).toISOString()}` : ""}`);
    return { ok: false, error: until ? "Too many wrong PINs. Try again later." : "Wrong PIN." };
  }
  d.prepare("delete from login_failures where user_id = ?").run(userId);
  return { ok: true };
}

export function logout(token: string) {
  getDb().prepare("delete from sessions where token = ?").run(token);
}

export async function currentUser(): Promise<User | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const row = getDb()
    .prepare("select user_id from sessions where token = ? and expires_at > ?")
    .get(token, new Date().toISOString()) as { user_id: number } | undefined;
  return (row && getUser(row.user_id)) ?? null;
}

export function unauthorized() {
  return Response.json({ error: "Log in first." }, { status: 401 });
}
