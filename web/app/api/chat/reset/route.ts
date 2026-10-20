import { currentUser, unauthorized } from "@/lib/auth";
import { addMessage } from "@/lib/chat";

/** Start a fresh conversation. Old messages stay on screen but Sal stops reading them. */
export async function POST() {
  const user = await currentUser();
  if (!user) return unauthorized();
  addMessage(user.id, "reset", "");
  return Response.json({ ok: true });
}
