import { cookies } from "next/headers";
import { login, SESSION_COOKIE } from "@/lib/auth";

export async function POST(req: Request) {
  const { userId, pin } = (await req.json()) as { userId?: number; pin?: string };
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
}
