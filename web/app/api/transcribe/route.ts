import { guarded } from "@/lib/http";
import { currentUser, unauthorized } from "@/lib/auth";
import { config } from "@/lib/config";

const MAX_BYTES = 15_000_000;

/** Voice note in, text out. Phones record webm (Android, desktop) or mp4/m4a (iPhone). */
export const POST = guarded("transcribe POST", async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const form = await req.formData().catch(() => null);
  if (!form) return Response.json({ error: "The upload was garbled. Try again." }, { status: 400 });
  const audio = form.get("audio");
  if (!(audio instanceof File) || !audio.size) return Response.json({ error: "No audio." }, { status: 400 });
  if (audio.size > MAX_BYTES) return Response.json({ error: "That voice note is too long." }, { status: 413 });

  const type = audio.type.split(";")[0];
  const ext = type.includes("mp4") || type.includes("m4a") || type.includes("aac") ? "m4a" : type.includes("ogg") ? "ogg" : type.includes("wav") ? "wav" : "webm";
  const out = new FormData();
  out.set("file", new File([await audio.arrayBuffer()], `voice.${ext}`, { type: type || "audio/webm" }));
  out.set("model", config.nanogpt.sttModel);
  out.set("language", "en");
  const res = await fetch(`${config.nanogpt.url}/api/v1/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.llm.apiKey}` },
    body: out,
    signal: AbortSignal.timeout(60_000),
  }).catch((e: Error) => {
    console.error("[transcribe]", e);
    return null;
  });
  if (!res) return Response.json({ error: "Couldn't reach the transcription service. Try again, or type it." }, { status: 502 });
  if (!res.ok) {
    console.error(`[transcribe] service answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    return Response.json({ error: "Couldn't transcribe that voice note. Try again, or type it." }, { status: 502 });
  }
  const data = (await res.json()) as { text?: string };
  return Response.json({ text: (data.text ?? "").trim() });
});
