import { currentUser, unauthorized } from "@/lib/auth";
import { guarded, readJson } from "@/lib/http";
import { changePantry, listPantry } from "@/lib/pantry";

/** What's already in the kitchen. Shared by the whole household. */
export const GET = guarded("pantry GET", async function GET() {
  const user = await currentUser();
  if (!user) return unauthorized();
  return Response.json({ items: listPantry() });
});

export const PATCH = guarded("pantry PATCH", async function PATCH(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const parsed = await readJson<{ add?: unknown; remove?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 30) : []);
  changePantry(user.id, strings(parsed.data.add), strings(parsed.data.remove));
  return Response.json({ items: listPantry() });
});
