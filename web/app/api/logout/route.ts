import { cookies } from "next/headers";
import { logout, SESSION_COOKIE } from "@/lib/auth";

export async function POST() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) logout(token);
  jar.delete(SESSION_COOKIE);
  return Response.json({ ok: true });
}
