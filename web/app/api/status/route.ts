import { guarded } from "@/lib/http";
import { currentUser, unauthorized } from "@/lib/auth";
import { mealieStatus } from "@/lib/mealie";

export const GET = guarded("status GET", async function GET() {
  if (!(await currentUser())) return unauthorized();
  return Response.json({ mealie: await mealieStatus() });
});
