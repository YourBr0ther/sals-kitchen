"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { ActionView, VisibleMessage } from "@/lib/chat";
import type { User } from "@/lib/db";
import Composer from "./Composer";
import { MicIcon } from "./icons";
import { api, jsonInit, timeLabel } from "./util";

type Streaming = { text: string; status: string | null };

const hideRepliesLine = (t: string) => t.replace(/\n*\s*replies:[^\n]*$/i, "");

function SalText({ text }: { text: string }) {
  return (
    <ReactMarkdown
      components={{
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>
        ),
        img: () => null,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

export default function ChatView({
  me,
  onChanged,
  onKeyboard,
}: {
  me: User;
  onChanged: (changed: string[]) => void;
  onKeyboard: (open: boolean) => void;
}) {
  const [messages, setMessages] = useState<VisibleMessage[] | null>(null);
  const [streaming, setStreaming] = useState<Streaming | null>(null);
  const [error, setError] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    api<{ messages: VisibleMessage[] }>("/api/chat")
      .then((d) => setMessages(d.messages))
      .catch((e) => setError(e.message));
  }, []);

  // follow new text unless the person scrolled up to read something
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  const onScroll = () => {
    const el = scroller.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const send = useCallback(
    async (text: string, attachments: string[] = [], voice = false) => {
      setError("");
      stick.current = true;
      const temp: VisibleMessage = {
        id: -Date.now(),
        role: "user",
        content: text,
        createdAt: new Date().toISOString(),
        attachments,
        voice,
      };
      setMessages((m) => [...(m ?? []), temp]);
      setStreaming({ text: "", status: null });

      try {
        const res = await fetch("/api/chat", jsonInit("POST", { text, attachments, voice }));
        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error ?? `Sal didn't answer (${res.status}).`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let finished = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let cut;
          while ((cut = buf.indexOf("\n\n")) >= 0) {
            const line = buf.slice(0, cut).replace(/^data: /, "");
            buf = buf.slice(cut + 2);
            if (!line) continue;
            const ev = JSON.parse(line);
            if (ev.type === "text") setStreaming((s) => ({ text: (s?.text ?? "") + ev.delta, status: null }));
            else if (ev.type === "status") setStreaming((s) => ({ text: s?.text ?? "", status: ev.label }));
            else if (ev.type === "error") throw new Error(ev.message);
            else if (ev.type === "done") {
              finished = true;
              setMessages((m) => [
                ...(m ?? []),
                { id: ev.messageId, role: "assistant", content: ev.text, createdAt: new Date().toISOString(), chips: ev.chips, actions: ev.actions },
              ]);
              if (ev.changed?.length) onChanged(ev.changed);
            }
          }
        }
        if (!finished) throw new Error("Lost the connection. Pull up the chat again in a moment; Sal's answer will be there.");
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setStreaming(null);
      }
    },
    [onChanged],
  );

  async function decide(action: ActionView, approve: boolean) {
    try {
      const r = await api<{ action: ActionView; changed: string[]; message?: string }>(
        `/api/actions/${action.id}`,
        jsonInit("POST", { approve }),
      );
      setMessages((ms) =>
        (ms ?? []).map((m) => (m.actions ? { ...m, actions: m.actions.map((a) => (a.id === action.id ? r.action : a)) } : m)),
      );
      if (r.changed?.length) onChanged(r.changed);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const lastAssistant = [...(messages ?? [])].reverse().find((m) => m.role !== "event")?.id;

  return (
    <>
      <div className="chat" ref={scroller} onScroll={onScroll} aria-live="polite">
        {messages && !messages.length && !streaming && (
          <div className="empty-chat">
            <img src="/icon.svg" alt="" />
            <p>Sal&apos;s in the kitchen. Ask him to plan this week, find something new, or tell him what you can&apos;t stand.</p>
            <div className="chips" style={{ justifyContent: "center" }}>
              {["Plan this week's dinners", "What's in our recipe box?", "Find me something new"].map((c) => (
                <button key={c} className="chip" style={{ color: "var(--forest)", borderColor: "var(--line)" }} onClick={() => send(c)}>{c}</button>
              ))}
            </div>
          </div>
        )}

        {messages?.map((m) =>
          m.role === "event" ? (
            <div key={m.id} className="event">{m.content}</div>
          ) : m.role === "user" ? (
            <div key={m.id} className="msg me">
              <span className="meta">{me.name}, {timeLabel(m.createdAt)}</span>
              <div className="bubble">
                {m.voice && <div className="voice-tag"><MicIcon />Voice note</div>}
                {!!m.attachments?.length && (
                  <div className="photos">
                    {m.attachments.map((id) => <img key={id} src={`/api/uploads/${id}`} alt="Photo you sent" />)}
                  </div>
                )}
                {m.content}
              </div>
            </div>
          ) : (
            <div key={m.id} className="msg sal">
              <span className="meta">Sal, {timeLabel(m.createdAt)}</span>
              <div className="bubble">
                <SalText text={m.content} />
                {m.actions?.map((a) => (
                  <div key={a.id} className="action-card">
                    <p>{a.summary}?</p>
                    {a.status === "pending" ? (
                      <div className="row">
                        <button className="yes" onClick={() => decide(a, true)}>{a.kind === "import_recipe_url" ? "Save it" : "Yes, update"}</button>
                        <button className="no" onClick={() => decide(a, false)}>No thanks</button>
                      </div>
                    ) : (
                      <span className="done">
                        {a.status === "approved" ? "Done." : a.status === "declined" ? "Skipped." : `Didn't work: ${a.result}`}
                      </span>
                    )}
                  </div>
                ))}
                {m.id === lastAssistant && !streaming && !!m.chips?.length && (
                  <div className="chips">
                    {m.chips.map((c) => <button key={c} className="chip" onClick={() => send(c)}>{c}</button>)}
                  </div>
                )}
              </div>
            </div>
          ),
        )}

        {streaming && (
          <div className="msg sal">
            <span className="meta">Sal</span>
            <div className="bubble">
              {streaming.text ? <SalText text={hideRepliesLine(streaming.text)} /> : !streaming.status && <span className="typing-dots"><i /><i /><i /></span>}
              {streaming.status && <span className="status">{streaming.status}</span>}
            </div>
          </div>
        )}
      </div>
      <Composer busy={Boolean(streaming)} error={error} setError={setError} onSend={send} onKeyboard={onKeyboard} />
    </>
  );
}
