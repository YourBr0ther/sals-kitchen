import { getDb } from "@/lib/db";

/** For Kubernetes probes: the app is up and the database opens. */
export function GET() {
  getDb().prepare("select 1").get();
  return Response.json({ ok: true });
}
