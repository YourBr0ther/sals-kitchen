import { currentUser, unauthorized } from "@/lib/auth";
import { guarded } from "@/lib/http";
import { stopTurn } from "@/lib/sal/agent";

/** The Stop button: cut Sal off mid-reply. What he'd said so far is kept. */
export const POST = guarded("chat/stop POST", async function POST() {
  const user = await currentUser();
  if (!user) return unauthorized();
  return Response.json({ stopped: stopTurn(user.id) });
});
