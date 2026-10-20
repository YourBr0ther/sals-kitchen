import { hashPin } from "@/lib/auth";
import { getDb, listUsers } from "@/lib/db";

const COLORS = ["#F2B33D", "#9FD3B8", "#F6A99C", "#B9B2F0", "#8EC5F2", "#F2C7E1"];

type Member = { name?: string; role?: string; pin?: string };

/** First run only: create the household. Refuses once anyone exists. */
export async function POST(req: Request) {
  if (listUsers().length) return Response.json({ error: "The household is already set up." }, { status: 409 });
  const { members, token } = (await req.json()) as { members?: Member[]; token?: string };
  // on a public URL, only someone with the setup link can claim the household
  const expected = process.env.SETUP_TOKEN?.trim();
  if (expected && token !== expected) return Response.json({ error: "This setup link isn't valid." }, { status: 403 });
  const clean = (members ?? [])
    .map((m) => ({ name: (m.name ?? "").trim(), role: m.role === "kid" ? "kid" : "adult", pin: (m.pin ?? "").trim() }))
    .filter((m) => m.name);
  if (!clean.some((m) => m.role === "adult")) return Response.json({ error: "Add at least one grown-up." }, { status: 400 });
  for (const m of clean) {
    if (m.name.length > 30) return Response.json({ error: `${m.name.slice(0, 30)}… is too long for a name.` }, { status: 400 });
    if (m.role === "adult" && !/^\d{4}$/.test(m.pin)) {
      return Response.json({ error: `${m.name} needs a 4-digit PIN.` }, { status: 400 });
    }
  }
  const names = new Set(clean.map((m) => m.name.toLowerCase()));
  if (names.size !== clean.length) return Response.json({ error: "Two people have the same name." }, { status: 400 });

  const insert = getDb().prepare("insert into users (name, role, color, pin_hash) values (?, ?, ?, ?)");
  getDb().transaction(() => {
    clean.forEach((m, i) => insert.run(m.name, m.role, COLORS[i % COLORS.length], m.role === "adult" ? hashPin(m.pin) : null));
  })();
  return Response.json({ ok: true });
}
