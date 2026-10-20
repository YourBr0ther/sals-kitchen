import { currentUser, unauthorized } from "@/lib/auth";
import { pastConversations, visibleMessages } from "@/lib/chat";
import { guarded } from "@/lib/http";

/** One earlier conversation, read-only. `id` is where it ended (its "new conversation" marker). */
export const GET = guarded("conversations/[id] GET", async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const through = Number((await params).id);
  const c = pastConversations(user.id, 1000).find((x) => x.through === through);
  if (!c) return Response.json({ error: "That conversation isn't there anymore." }, { status: 404 });
  return Response.json({ conversation: c, messages: visibleMessages(user.id, { after: c.after, through: c.through }, 400) });
});
