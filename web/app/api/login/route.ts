import { guarded, readJson } from "@/lib/http";
import { cookies } from "next/headers";
import { login, SESSION_COOKIE } from "@/lib/auth";

export const POST = guarded("login POST", async function POST(req: Request) {
  const parsed = await readJson<{ userId?: number; pin?: string }>(req);
  if (!parsed.ok) return parsed.response;
  const { userId, pin } = parsed.data;
  if (!userId || typeof pin !== "string") return Response.json({ error: "Pick a person and enter a PIN." }, { status: 400 });
  const result = login(Number(userId), pin);
  if (!result.ok) return Response.json({ error: result.error }, { status: 401 });
  (await cookies()).set(SESSION_COOKIE, result.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: result.maxAge,
  });
  return Response.json({ ok: true });
});
