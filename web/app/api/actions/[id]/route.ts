import { guarded, readJson } from "@/lib/http";
import { currentUser, unauthorized } from "@/lib/auth";
import { addMessage, getActions } from "@/lib/chat";
import { declineAction, executeAction } from "@/lib/sal/tools";

export const POST = guarded("actions/[id] POST", async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "No such request." }, { status: 404 });
  const parsed = await readJson<{ approve?: boolean }>(req);
  if (!parsed.ok) return parsed.response;
  const { approve } = parsed.data;
  try {
    if (approve) {
      const r = await executeAction(id, user);
      // Sal reads this on the next turn, so he knows it happened
      addMessage(user.id, "event", r.ok ? `${user.name} approved: ${r.message}` : `${user.name} approved, but it failed: ${r.message}`);
      return Response.json({ ...r, action: getActions([id], user.id)[0] }, { status: r.ok ? 200 : 502 });
    }
    const summary = declineAction(id, user);
    addMessage(user.id, "event", `${user.name} declined: ${summary}`);
    return Response.json({ ok: true, action: getActions([id], user.id)[0], changed: [] });
  } catch (e) {
    // e.g. it was already handled on another phone: send back its current state so the card catches up
    return Response.json({ error: (e as Error).message, action: getActions([id], user.id)[0] }, { status: 400 });
  }
});
