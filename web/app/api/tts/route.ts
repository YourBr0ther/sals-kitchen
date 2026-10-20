import fs from "node:fs";
import path from "node:path";
import { currentUser, unauthorized } from "@/lib/auth";
import { config } from "@/lib/config";
import { getDb } from "@/lib/db";
import { guarded, readJson } from "@/lib/http";

const MAX_CHARS = 3000;

/** Markdown and links read badly out loud: keep the words, drop the punctuation around them. */
function speakable(md: string): string {
  return md
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_`#>]/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s*…\s*$/, ".")
    .replace(/\n{2,}/g, "\n")
    .trim()
    .slice(0, MAX_CHARS);
}

/** Sal reads one of his replies out loud. Audio is kept, so replaying it costs nothing. */
export const POST = guarded("tts POST", async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const parsed = await readJson<{ messageId?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const id = Number(parsed.data.messageId);
  const row = getDb().prepare("select content, payload from messages where id = ? and user_id = ? and role = 'assistant'").get(id, user.id) as
    | { content: string; payload: string }
    | undefined;
  if (!row) return Response.json({ error: "That message isn't there." }, { status: 404 });

  const dir = path.join(config.dataDir, "tts");
  const file = path.join(dir, `${id}.mp3`);
  const headers = { "Content-Type": "audio/mpeg", "Cache-Control": "private, max-age=86400" };
  if (fs.existsSync(file)) return new Response(fs.readFileSync(file), { headers });

  const text = speakable((JSON.parse(row.payload) as { display?: string }).display ?? row.content);
  if (!text) return Response.json({ error: "Nothing to read out." }, { status: 400 });
  const res = await fetch(`${config.nanogpt.url}/api/v1/audio/speech`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.llm.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.nanogpt.ttsModel,
      voice: config.nanogpt.ttsVoice,
      input: text,
      instructions: config.nanogpt.ttsInstructions,
      response_format: "mp3",
    }),
    signal: AbortSignal.timeout(60_000),
  }).catch((e: Error) => {
    console.error("[tts]", e);
    return null;
  });
  if (!res?.ok) {
    if (res) console.error(`[tts] service answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    return Response.json({ error: "Sal's voice isn't working right now." }, { status: 502 });
  }
  const audio = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, audio);
  return new Response(audio, { headers: { ...headers, "Content-Type": res.headers.get("content-type") || "audio/mpeg" } });
});
