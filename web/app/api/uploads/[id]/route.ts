import fs from "node:fs";
import { currentUser, unauthorized } from "@/lib/auth";
import { uploadPath } from "@/lib/chat";
import { getDb } from "@/lib/db";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await currentUser())) return unauthorized();
  const { id } = await ctx.params;
  const row = getDb().prepare("select mime from uploads where id = ?").get(id) as { mime: string } | undefined;
  const file = uploadPath(id);
  if (!row || !fs.existsSync(file)) return new Response("Not found", { status: 404 });
  return new Response(fs.readFileSync(file), {
    headers: { "Content-Type": row.mime, "Cache-Control": "private, max-age=31536000, immutable" },
  });
}
