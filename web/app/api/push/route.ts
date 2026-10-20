import { guarded, readJson } from "@/lib/http";
import { currentUser, unauthorized } from "@/lib/auth";
import { config } from "@/lib/config";
import { pushConfigured, removeSubscription, saveSubscription, isPushEndpoint } from "@/lib/push";

/** Whether the server can send reminders, and the key a phone needs to sign up. */
export const GET = guarded("push GET", async function GET() {
  const user = await currentUser();
  if (!user) return unauthorized();
  const configured = pushConfigured();
  return Response.json({ configured, publicKey: configured ? config.push.publicKey : null });
});

type SubBody = { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };

const validEndpoint = (s: unknown): s is string => typeof s === "string" && s.length <= 1000 && isPushEndpoint(s);
// base64url, as browsers send them
const validKey = (s: unknown, max: number): s is string => typeof s === "string" && s.length > 0 && s.length <= max && /^[\w-]+=*$/.test(s);

/** Sign this phone up for this person's reminders. */
export const POST = guarded("push POST", async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  if (!pushConfigured()) return Response.json({ error: "Reminders aren't set up on the server yet." }, { status: 503 });
  const parsed = await readJson<SubBody>(req);
  if (!parsed.ok) return parsed.response;
  const { endpoint, keys } = parsed.data;
  if (!validEndpoint(endpoint) || !validKey(keys?.p256dh, 200) || !validKey(keys?.auth, 100)) {
    return Response.json({ error: "This phone sent a sign-up Sal can't use. Try turning reminders on again." }, { status: 400 });
  }
  saveSubscription(user.id, { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } });
  return Response.json({ ok: true });
});

/** Stop sending to this phone. */
export const DELETE = guarded("push DELETE", async function DELETE(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const parsed = await readJson<{ endpoint?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  if (typeof parsed.data.endpoint !== "string") return Response.json({ error: "Which phone? The request didn't say." }, { status: 400 });
  return Response.json({ ok: true, removed: removeSubscription(parsed.data.endpoint, user.id) });
});
