import fs from "node:fs";
import path from "node:path";
import { currentUser, unauthorized } from "@/lib/auth";
import { config } from "@/lib/config";
import { getDb } from "@/lib/db";
import type { NextRequest } from "next/server";
import { guarded } from "@/lib/http";

const MAX_CHARS = 3000;
const MIN_AUDIO_BYTES = 2000;

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

/**
 * Sal reads one of his replies out loud. The audio streams as it's made, so a long reply
 * starts playing in a second or two; a finished copy is kept so replaying it costs nothing.
 */
export const GET = guarded("tts GET", async function GET(req: NextRequest) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const id = Number(req.nextUrl.searchParams.get("id"));
  const row = getDb().prepare("select content, payload from messages where id = ? and user_id = ? and role = 'assistant'").get(id, user.id) as
    | { content: string; payload: string }
    | undefined;
  if (!row) return Response.json({ error: "That message isn't there." }, { status: 404 });

  const dir = path.join(config.dataDir, "tts");
  const file = path.join(dir, `${id}.mp3`);
  const headers = { "Content-Type": "audio/mpeg", "Cache-Control": "private, max-age=86400" };
  // anything this small is a broken earlier attempt, not speech
  if (fs.existsSync(file)) {
    if (fs.statSync(file).size >= MIN_AUDIO_BYTES) return new Response(fs.readFileSync(file), { headers });
    fs.rmSync(file, { force: true });
  }

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
      stream: true,
    }),
    signal: AbortSignal.timeout(90_000),
  }).catch((e: Error) => {
    console.error("[tts]", e);
    return null;
  });
  const type = res?.headers.get("content-type") ?? "";
  if (!res?.ok || !res.body || !type.startsWith("audio/")) {
    if (res) console.error(`[tts] service answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    return Response.json({ error: "Sal's voice isn't working right now." }, { status: 502 });
  }
  const [toPhone, toDisk] = res.body.tee();
  // keep a copy only once the whole thing has arrived
  void (async () => {
    const chunks: Uint8Array[] = [];
    try {
      const reader = toDisk.getReader();
      for (let r = await reader.read(); !r.done; r = await reader.read()) chunks.push(r.value);
      const audio = Buffer.concat(chunks);
      if (audio.length < MIN_AUDIO_BYTES) return;
      // written whole and then moved into place, so a half-written file is never served
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${file}.part`, audio);
      fs.renameSync(`${file}.part`, file);
    } catch (e) {
      console.warn(`[tts] didn't keep audio for message ${id}:`, (e as Error).message);
    }
  })();
  return new Response(toPhone, { headers: { ...headers, "Content-Type": type } });
});
