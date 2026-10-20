import { guarded } from "@/lib/http";
import { currentUser, unauthorized } from "@/lib/auth";
import { pushConfigured, sendToUser } from "@/lib/push";

/** Send a test reminder to every phone the signed-in person has turned reminders on for. */
export const POST = guarded("push test POST", async function POST() {
  const user = await currentUser();
  if (!user) return unauthorized();
  if (!pushConfigured()) return Response.json({ error: "Reminders aren't set up on the server yet." }, { status: 503 });
  const result = await sendToUser(user.id, { title: "Sal's Kitchen", body: "Sal here. Reminders are on.", url: "/", tag: "test" });
  // the push services' status codes stay in the server log; the phone only needs to know if it worked
  if (!result.sent) {
    if (result.failed) console.warn(`[push] test for user ${user.id} failed: ${result.statuses.join(", ")}`);
    const error = result.failed
      ? "The push service didn't take it. Try again in a minute."
      : result.removed
        ? "This phone's sign-up for reminders expired. Turn reminders off and on again."
        : "No phone has reminders turned on for you yet.";
    return Response.json({ error }, { status: result.failed ? 502 : 404 });
  }
  return Response.json({ ok: true, sent: result.sent });
});
