import { recentActivity } from "@/lib/activity";
import { currentUser, unauthorized } from "@/lib/auth";
import { guarded } from "@/lib/http";

/** What everyone has been up to: plans, saves, lists, and how dinners went. */
export const GET = guarded("activity GET", async function GET() {
  const user = await currentUser();
  if (!user) return unauthorized();
  return Response.json({ activity: recentActivity(12) });
});
