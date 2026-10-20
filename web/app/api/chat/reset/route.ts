import { guarded } from "@/lib/http";
import { currentUser, unauthorized } from "@/lib/auth";
import { addMessage } from "@/lib/chat";
import { closeConversation } from "@/lib/memory";
import { isBusy } from "@/lib/sal/agent";

/** Start a fresh conversation. Old messages stay on screen but Sal stops reading them. */
export const POST = guarded("chat/reset POST", async function POST() {
  const user = await currentUser();
  if (!user) return unauthorized();
  if (isBusy(user.id)) return Response.json({ error: "Wait for Sal to finish answering, then start fresh." }, { status: 409 });
  // reads the old conversation right away, then saves its lasting facts in the background
  void closeConversation(user.id, user.name);
  addMessage(user.id, "reset", "");
  return Response.json({ ok: true });
});
