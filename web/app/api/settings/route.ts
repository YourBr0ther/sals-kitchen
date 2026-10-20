import { guarded, readJson } from "@/lib/http";
import { currentUser, unauthorized } from "@/lib/auth";
import { getSettings, updateSettings } from "@/lib/settings";

export const GET = guarded("settings GET", async function GET() {
  const user = await currentUser();
  if (!user) return unauthorized();
  return Response.json(getSettings(user.id));
});

/** Merge a change into this person's settings. Unknown keys and bad values are ignored. */
export const PATCH = guarded("settings PATCH", async function PATCH(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const parsed = await readJson<Record<string, unknown>>(req);
  if (!parsed.ok) return parsed.response;
  return Response.json(updateSettings(user.id, parsed.data));
});
