import { checkPin, currentUser, hashPin, unauthorized } from "@/lib/auth";
import { getDb, listUsers } from "@/lib/db";
import { guarded, readJson } from "@/lib/http";
import { logActivity } from "@/lib/activity";

const COLORS = ["#F2B33D", "#9FD3B8", "#F6A99C", "#B9B2F0", "#8EC5F2", "#F2C7E1"];

export const GET = guarded("household GET", async function GET() {
  const user = await currentUser();
  if (!user) return unauthorized();
  return Response.json({ members: listUsers() });
});

/** A grown-up adds someone to the household. Kids don't get a PIN; they can't log in. */
export const POST = guarded("household POST", async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  if (user.role !== "adult") return Response.json({ error: "Only grown-ups can add people." }, { status: 403 });
  const parsed = await readJson<{ name?: unknown; role?: unknown; pin?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const name = typeof parsed.data.name === "string" ? parsed.data.name.trim() : "";
  const role = parsed.data.role === "kid" ? "kid" : "adult";
  const pin = typeof parsed.data.pin === "string" ? parsed.data.pin.trim() : "";
  if (!name) return Response.json({ error: "Give them a name." }, { status: 400 });
  if (name.length > 30) return Response.json({ error: "That name is too long." }, { status: 400 });
  if (role === "adult" && !/^\d{4}$/.test(pin)) return Response.json({ error: "Grown-ups need a 4-digit PIN." }, { status: 400 });
  const members = listUsers();
  if (members.some((m) => m.name.toLowerCase() === name.toLowerCase())) return Response.json({ error: `${name} is already here.` }, { status: 409 });
  if (members.length >= 12) return Response.json({ error: "That's a full table already." }, { status: 400 });
  getDb()
    .prepare("insert into users (name, role, color, pin_hash) values (?, ?, ?, ?)")
    .run(name, role, COLORS[members.length % COLORS.length], role === "adult" ? hashPin(pin) : null);
  logActivity(user.id, `added ${name} to the household`);
  return Response.json({ members: listUsers() });
});

/** Change your own PIN. The current one is required, so a borrowed unlocked phone can't do it. */
export const PATCH = guarded("household PATCH", async function PATCH(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const parsed = await readJson<{ currentPin?: unknown; newPin?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const { currentPin, newPin } = parsed.data;
  if (typeof newPin !== "string" || !/^\d{4}$/.test(newPin)) return Response.json({ error: "The new PIN needs 4 digits." }, { status: 400 });
  const checked = checkPin(user.id, typeof currentPin === "string" ? currentPin : "");
  if (!checked.ok) return Response.json({ error: checked.error === "Wrong PIN." ? "Your current PIN doesn't match." : checked.error }, { status: 403 });
  getDb().prepare("update users set pin_hash = ? where id = ?").run(hashPin(newPin), user.id);
  return Response.json({ ok: true });
});
