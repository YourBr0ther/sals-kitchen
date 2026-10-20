import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { currentUser, unauthorized } from "@/lib/auth";
import { uploadPath } from "@/lib/chat";
import { getDb } from "@/lib/db";

const TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 6_000_000;

/** Photos are resized on the phone before upload, so these stay small. */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const form = await req.formData();
  const file = form.get("image");
  if (!(file instanceof File)) return Response.json({ error: "No photo." }, { status: 400 });
  if (!TYPES.has(file.type)) return Response.json({ error: "Send a JPEG, PNG, or WebP photo." }, { status: 415 });
  if (file.size > MAX_BYTES) return Response.json({ error: "That photo is too big." }, { status: 413 });
  const id = crypto.randomBytes(12).toString("base64url");
  const dest = uploadPath(id);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await file.arrayBuffer()));
  getDb().prepare("insert into uploads (id, user_id, mime) values (?, ?, ?)").run(id, user.id, file.type);
  return Response.json({ id });
}
