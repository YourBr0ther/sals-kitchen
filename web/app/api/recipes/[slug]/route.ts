import { guarded } from "@/lib/http";
import { currentUser, unauthorized } from "@/lib/auth";
import { getRecipeDetail, isRecipeSlug, MealieError } from "@/lib/mealie";

/** One recipe laid out for the recipe card sheet. */
export const GET = guarded("recipes/[slug] GET", async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const { slug } = await ctx.params;
  if (!isRecipeSlug(slug)) return Response.json({ error: "That recipe isn't in the box." }, { status: 404 });
  try {
    return Response.json(await getRecipeDetail(slug), { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    if (!(e instanceof MealieError)) throw e;
    const missing = e.message.startsWith("Mealie couldn't find");
    return Response.json({ error: missing ? "That recipe isn't in the box anymore." : e.message }, { status: missing ? 404 : 502 });
  }
});
