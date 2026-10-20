import { currentUser, unauthorized } from "@/lib/auth";
import { addMessage, visibleMessages } from "@/lib/chat";
import { getDb } from "@/lib/db";
import { runTurn } from "@/lib/sal/agent";

export async function GET() {
  const user = await currentUser();
  if (!user) return unauthorized();
  return Response.json({ messages: visibleMessages(user.id) });
}

// one turn at a time per person, so a double-tap doesn't run Sal twice
const busy = new Set<number>();

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const body = (await req.json()) as { text?: string; attachments?: string[]; voice?: boolean; followUp?: boolean };
  const text = (body.text ?? "").trim().slice(0, 4000);
  const attachments = (body.attachments ?? []).filter((id) => typeof id === "string").slice(0, 4);
  // a follow-up lets Sal react to something that just happened (like a failed save) without a new message
  if (!body.followUp && !text && !attachments.length) return Response.json({ error: "Say something first." }, { status: 400 });
  if (attachments.length) {
    const owned = getDb()
      .prepare(`select count(*) as n from uploads where user_id = ? and id in (${attachments.map(() => "?").join(",")})`)
      .get(user.id, ...attachments) as { n: number };
    if (owned.n !== attachments.length) return Response.json({ error: "Unknown photo." }, { status: 400 });
  }
  if (busy.has(user.id)) return Response.json({ error: "Sal's still answering your last message." }, { status: 409 });

  busy.add(user.id);
  const userMessageId = body.followUp ? null : addMessage(user.id, "user", text, { attachments, voice: Boolean(body.voice) });
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: object) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      send({ type: "accepted", userMessageId });
      try {
        // keep going if the phone drops the connection; the reply is saved and shows up on reload
        for await (const ev of runTurn(user)) {
          try {
            send(ev);
          } catch {
            // client went away
          }
        }
      } finally {
        busy.delete(user.id);
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
  });
}
