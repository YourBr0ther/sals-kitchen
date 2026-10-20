import { currentUser, unauthorized } from "@/lib/auth";
import { addMessage, pastConversations, visibleMessages } from "@/lib/chat";
import { getDb } from "@/lib/db";
import { guarded, readJson } from "@/lib/http";
import { isBusy, releaseTurn, runTurn, tryStartTurn } from "@/lib/sal/agent";

/** History plus whether Sal is mid-reply, so a reopened app knows to wait for it. */
export const GET = guarded("chat GET", async function GET() {
  const user = await currentUser();
  if (!user) return unauthorized();
  return Response.json({ messages: visibleMessages(user.id), busy: isBusy(user.id), hasPast: pastConversations(user.id, 1).length > 0 });
});

// a turn that runs longer than this is cut off, so a stalled service can't lock someone out
const TURN_DEADLINE_MS = 4 * 60_000;
// phones and proxies drop SSE connections that go quiet; send a comment this often
const KEEPALIVE_MS = 15_000;

export const POST = guarded("chat POST", async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const parsed = await readJson<{ text?: unknown; attachments?: unknown; voice?: unknown; followUp?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 4000) : "";
  const attachments = (Array.isArray(body.attachments) ? body.attachments : []).filter((id): id is string => typeof id === "string").slice(0, 4);
  const followUp = body.followUp === true;
  // a follow-up lets Sal react to something that just happened (like a failed save) without a new message
  if (!followUp && !text && !attachments.length) return Response.json({ error: "Say something first." }, { status: 400 });
  if (attachments.length) {
    const owned = getDb()
      .prepare(`select count(*) as n from uploads where user_id = ? and id in (${attachments.map(() => "?").join(",")})`)
      .get(user.id, ...attachments) as { n: number };
    if (owned.n !== attachments.length) return Response.json({ error: "That photo didn't upload. Attach it again." }, { status: 400 });
  }
  const stopped = tryStartTurn(user.id);
  if (!stopped) return Response.json({ error: "Sal's still answering your last message.", busy: true }, { status: 409 });

  let userMessageId: number | null = null;
  try {
    userMessageId = followUp ? null : addMessage(user.id, "user", text, { attachments, voice: body.voice === true });
  } catch (e) {
    releaseTurn(user.id);
    throw e;
  }

  const encoder = new TextEncoder();
  const signal = AbortSignal.any([AbortSignal.timeout(TURN_DEADLINE_MS), stopped]);
  const stream = new ReadableStream({
    async start(controller) {
      let open = true;
      const write = (chunk: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          open = false; // the phone went away; keep the turn running so the reply is saved
        }
      };
      const send = (obj: object) => write(`data: ${JSON.stringify(obj)}\n\n`);
      const keepalive = setInterval(() => write(": keepalive\n\n"), KEEPALIVE_MS);
      send({ type: "accepted", userMessageId });
      try {
        for await (const ev of runTurn(user, signal, stopped)) send(ev);
      } catch (e) {
        console.error(`[chat] stream for user ${user.id} failed:`, e);
        send({ type: "error", message: "Something went wrong on Sal's end. Try again.", retryable: true });
      } finally {
        clearInterval(keepalive);
        releaseTurn(user.id);
        if (open) {
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
  });
});
