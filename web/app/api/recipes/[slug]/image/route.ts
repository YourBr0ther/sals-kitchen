import { guarded } from "@/lib/http";
import { currentUser, unauthorized } from "@/lib/auth";
import { getRecipeImage, isRecipeSlug, MealieError } from "@/lib/mealie";

/** The recipe photo, passed through from Mealie's internal address, which phones can't reach. */
export const GET = guarded("recipes/[slug]/image GET", async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const { slug } = await ctx.params;
  if (!isRecipeSlug(slug)) return new Response("Not found", { status: 404 });
  let photo: Awaited<ReturnType<typeof getRecipeImage>>;
  try {
    photo = await getRecipeImage(slug);
  } catch (e) {
    if (!(e instanceof MealieError)) throw e;
    return new Response("Not found", { status: 404 });
  }
  if (!photo) return new Response("Not found", { status: 404 });
  return new Response(photo.body, {
    headers: {
      // only photo types go back out (no SVG or HTML), so a proxied file can't run script here
      "Content-Type": /^image\/(webp|jpeg|png|avif|gif)$/.test(photo.type) ? photo.type : "image/webp",
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
