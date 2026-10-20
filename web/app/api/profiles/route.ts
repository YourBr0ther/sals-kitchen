import { guarded, readJson } from "@/lib/http";
import { currentUser, unauthorized } from "@/lib/auth";
import { applyProfileChange, canEditProfile, getProfile, getUser, listUsers, PROFILE_LISTS, type ProfileChange } from "@/lib/db";

function allProfiles() {
  return listUsers().map((u) => ({ user: u, profile: getProfile(u.id) }));
}

export const GET = guarded("profiles GET", async function GET() {
  const me = await currentUser();
  if (!me) return unauthorized();
  return Response.json({
    profiles: allProfiles().map((p) => ({ ...p, editable: canEditProfile(me, p.user) })),
  });
});

/** Manual edits from the profiles screen. */
export const PATCH = guarded("profiles PATCH", async function PATCH(req: Request) {
  const me = await currentUser();
  if (!me) return unauthorized();
  const parsed = await readJson<{ userId?: number; list?: string; add?: string; remove?: string }>(req);
  if (!parsed.ok) return parsed.response;
  const { userId, list, add, remove } = parsed.data;
  const target = userId ? getUser(Number(userId)) : undefined;
  if (!target) return Response.json({ error: "No such person." }, { status: 404 });
  if (!canEditProfile(me, target)) return Response.json({ error: `Only ${target.name} can change this profile.` }, { status: 403 });
  if (!PROFILE_LISTS.includes(list as never)) return Response.json({ error: "Bad list." }, { status: 400 });
  const l = list as (typeof PROFILE_LISTS)[number];
  const change: ProfileChange = {};
  if (add?.trim()) change.add = { [l]: [add.trim().slice(0, 80)] };
  if (remove) change.remove = { [l]: [remove] };
  applyProfileChange(target.id, change, me.id, "manual");
  return Response.json({ profiles: allProfiles().map((p) => ({ ...p, editable: canEditProfile(me, p.user) })) });
});
