import { guarded } from "@/lib/http";
import fs from "node:fs";
import { currentUser, unauthorized } from "@/lib/auth";
import { uploadPath } from "@/lib/chat";
import { getDb } from "@/lib/db";

export const GET = guarded("uploads/[id] GET", async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  // photos are private to whoever sent them
  const row = getDb().prepare("select mime from uploads where id = ? and user_id = ?").get(id, user.id) as { mime: string } | undefined;
  const file = uploadPath(id);
  if (!row || !fs.existsSync(file)) return new Response("Not found", { status: 404 });
  return new Response(fs.readFileSync(file), {
    headers: { "Content-Type": row.mime, "Cache-Control": "private, max-age=31536000, immutable" },
  });
});
