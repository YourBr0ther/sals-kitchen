import { currentUser, unauthorized } from "@/lib/auth";
import { mealieStatus } from "@/lib/mealie";

export async function GET() {
  if (!(await currentUser())) return unauthorized();
  return Response.json({ mealie: await mealieStatus() });
}
