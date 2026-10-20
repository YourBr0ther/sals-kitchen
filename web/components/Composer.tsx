"use client";

import { useEffect, useRef, useState } from "react";
import { LinkIcon, MicIcon, PhotoIcon, SendIcon, StopIcon, XIcon } from "./icons";
import { api, shrinkImage } from "./util";

type Attachment = { id: string; preview: string };

const MAX_RECORD_MS = 2 * 60_000;

function pickMime() {
  if (typeof MediaRecorder === "undefined") return "";
  for (const t of ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg"]) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

export default function Composer({
  busy,
  onSend,
  onKeyboard,
}: {
  busy: boolean;
  /** resolves false if the message never reached Sal */
  onSend: (text: string, attachments: string[], voice?: boolean) => Promise<boolean>;
  onKeyboard: (open: boolean) => void;
}) {
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [recording, setRecording] = useState<{ started: number } | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [now, setNow] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const cancelled = useRef(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // the recorder's stop handler outlives the render it was made in; read photos through a ref
  const attachmentsRef = useRef<Attachment[]>([]);
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => {
      setNow(Date.now());
      if (Date.now() - recording.started > MAX_RECORD_MS) recorder.current?.stop();
    }, 250);
    return () => clearInterval(t);
  }, [recording]);

  const hasContent = text.trim() !== "" || attachments.length > 0;

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (busy || uploading || !hasContent) return;
    const draft = { text, attachments };
    setError("");
    setText("");
    setAttachments([]);
    const ok = await onSend(draft.text.trim(), draft.attachments.map((a) => a.id));
    if (ok) {
      draft.attachments.forEach((a) => URL.revokeObjectURL(a.preview));
    } else {
      // it didn't go through: put the draft back instead of losing it
      setText((t) => t || draft.text);
      setAttachments((a) => (a.length ? a : draft.attachments));
    }
  }

  async function addPhotos(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setError("");
    try {
      for (const file of [...files].slice(0, 4 - attachments.length)) {
        const blob = await shrinkImage(file);
        const form = new FormData();
        form.set("image", new File([blob], "photo.jpg", { type: "image/jpeg" }));
        const { id } = await api<{ id: string }>("/api/uploads", { method: "POST", body: form });
        setAttachments((a) => [...a, { id, preview: URL.createObjectURL(blob) }]);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function pasteLink() {
    try {
      const clip = (await navigator.clipboard.readText()).trim();
      if (/^https?:\/\/\S+$/.test(clip)) {
        setText((t) => (t ? `${t} ${clip}` : clip));
        input.current?.focus();
        return;
      }
    } catch {
      // clipboard blocked; fall through
    }
    setText((t) => (t ? `${t} https://` : "https://"));
    input.current?.focus();
  }

  async function startRecording() {
    setError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("This browser can't record audio here. Voice notes need the app on https.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = pickMime();
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      cancelled.current = false;
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(null);
        if (cancelled.current || !chunks.length) return;
        setTranscribing(true);
        try {
          const form = new FormData();
          form.set("audio", new Blob(chunks, { type: rec.mimeType || "audio/webm" }), "voice");
          const { text: said } = await api<{ text: string }>("/api/transcribe", { method: "POST", body: form });
          const sending = attachmentsRef.current;
          if (!said) {
            setError("Couldn't make out any words. Try again?");
          } else if (await onSend(said, sending.map((a) => a.id), true)) {
            const sent = new Set(sending.map((a) => a.id));
            setAttachments((all) => all.filter((a) => !sent.has(a.id)));
          } else {
            // keep what was said so it isn't lost
            setText((t) => (t ? `${t} ${said}` : said));
          }
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setTranscribing(false);
        }
      };
      recorder.current = rec;
      rec.start();
      setRecording({ started: Date.now() });
      setNow(Date.now());
    } catch (e) {
      const name = (e as Error).name;
      setError(
        name === "NotAllowedError"
          ? "Sal can't hear you. Allow the microphone for this app in your phone's settings, then try again."
          : name === "NotFoundError"
            ? "No microphone found on this device."
            : "Couldn't start recording. Try again.",
      );
    }
  }

  function stopRecording(cancel = false) {
    cancelled.current = cancel;
    recorder.current?.stop();
  }

  // keep focus in the text box when a button is pressed, so the keyboard stays up
  // and the layout doesn't jump under the finger mid-tap
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();

  const secs = recording ? Math.floor((now - recording.started) / 1000) : 0;

  return (
    <div className="composer">
      {!!attachments.length && (
        <div className="attach-row">
          {attachments.map((a) => (
            <div className="thumb" key={a.id}>
              <img src={a.preview} alt="Photo to send" />
              <button aria-label="Remove photo" onClick={() => setAttachments((as) => as.filter((x) => x.id !== a.id))}>×</button>
            </div>
          ))}
        </div>
      )}
      <form onSubmit={(e) => void submit(e)} onMouseDown={(e) => e.target !== input.current && keepFocus(e)}>
        {recording ? (
          <>
            <button type="button" className="tool" aria-label="Cancel recording" onClick={() => stopRecording(true)}><XIcon /></button>
            <div className="rec-bar" role="status">Recording {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}</div>
            <button type="button" className="tool mic rec" aria-label="Stop and send voice note" onClick={() => stopRecording()}><StopIcon /></button>
          </>
        ) : (
          <>
            <button type="button" className="tool" aria-label="Attach a photo" disabled={uploading || attachments.length >= 4} onClick={() => fileInput.current?.click()}>
              <PhotoIcon />
            </button>
            <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => addPhotos(e.target.files)} />
            <button type="button" className="tool" aria-label="Paste a recipe link" onClick={pasteLink}><LinkIcon /></button>
            <label className="sr-only" htmlFor="msg">Message Sal</label>
            <textarea
              id="msg"
              ref={input}
              rows={1}
              value={text}
              placeholder={transcribing ? "Listening back…" : uploading ? "Uploading photo…" : "Message Sal"}
              enterKeyHint="send"
              autoComplete="off"
              onChange={(e) => setText(e.target.value)}
              onFocus={() => {
                clearTimeout(blurTimer.current);
                onKeyboard(true);
              }}
              // bring the tab bar back only after the tap that caused the blur has landed,
              // or the layout shifts under the finger and the tap misses
              onBlur={() => {
                blurTimer.current = setTimeout(() => onKeyboard(false), 350);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
            {hasContent ? (
              <button type="submit" className="tool send" aria-label="Send" disabled={busy || uploading}><SendIcon /></button>
            ) : (
              <button type="button" className="tool mic" aria-label="Record a voice note" disabled={busy || transcribing} onClick={startRecording}>
                <MicIcon />
              </button>
            )}
          </>
        )}
      </form>
      {error ? <p className="error-line" role="alert">{error}</p> : <p className="hint">Text, voice notes, photos of your fridge, or a link to a recipe you saw.</p>}
    </div>
  );
}
