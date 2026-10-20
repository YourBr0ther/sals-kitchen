import { currentUser, unauthorized } from "@/lib/auth";
import { addMessage, getActions } from "@/lib/chat";
import { declineAction, executeAction } from "@/lib/sal/tools";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const id = Number((await ctx.params).id);
  const { approve } = (await req.json()) as { approve?: boolean };
  try {
    if (approve) {
      const r = await executeAction(id, user);
      // Sal reads this on the next turn, so he knows it happened
      addMessage(user.id, "event", r.ok ? `${user.name} approved: ${r.message}` : `${user.name} approved, but it failed: ${r.message}`);
      return Response.json({ ...r, action: getActions([id])[0] }, { status: r.ok ? 200 : 502 });
    }
    const summary = declineAction(id, user);
    addMessage(user.id, "event", `${user.name} declined: ${summary}`);
    return Response.json({ ok: true, action: getActions([id])[0], changed: [] });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
