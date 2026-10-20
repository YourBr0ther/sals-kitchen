"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { ActionView, VisibleMessage } from "@/lib/chat";
import type { User } from "@/lib/db";
import Composer from "./Composer";
import { MicIcon } from "./icons";
import { jsonInit, timeLabel } from "./util";

type Streaming = { text: string; status: string | null };
type Problem = { message: string; retry: boolean };

const hideRepliesLine = (t: string) => t.replace(/\n*\s*replies:[^\n]*$/i, "");

// the server sends a keepalive every 15s; this much silence means the connection died
const STALL_MS = 40_000;
const POLL_MS = 3_000;

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

async function fetchHistory(): Promise<{ messages: VisibleMessage[]; busy: boolean }> {
  const res = await fetch("/api/chat", { cache: "no-store" });
  if (res.status === 401) {
    window.location.assign("/login");
    throw new Error("Signed out");
  }
  if (!res.ok) throw new Error("Couldn't load the chat.");
  return res.json();
}

export default function ChatView({
  me,
  onChanged,
  onKeyboard,
  onBusy,
}: {
  me: User;
  onChanged: (changed: string[]) => void;
  onKeyboard: (open: boolean) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [messages, setMessages] = useState<VisibleMessage[] | null>(null);
  const [streaming, setStreaming] = useState<Streaming | null>(null);
  // Sal is answering, but this screen lost the live stream (app backgrounded, signal dropped)
  const [waiting, setWaiting] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [deciding, setDeciding] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const sendingRef = useRef(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const busy = Boolean(streaming) || waiting;
  useEffect(() => onBusy(busy), [busy, onBusy]);

  /** Reload history from the server; if Sal is still mid-reply, keep checking until he's done. */
  const again = useRef<() => void>(() => {});
  const onChangedRef = useRef(onChanged);
  useEffect(() => {
    onChangedRef.current = onChanged;
  }, [onChanged]);
  const wasWaiting = useRef(false);
  const resync = useCallback(async () => {
    clearTimeout(pollTimer.current);
    try {
      const data = await fetchHistory();
      // a send started while this was loading; its own stream owns the screen now
      if (sendingRef.current) return;
      setLoadFailed(false);
      setMessages(data.messages);
      setWaiting(data.busy);
      if (data.busy) {
        wasWaiting.current = true;
        pollTimer.current = setTimeout(() => again.current(), POLL_MS);
        return;
      }
      if (wasWaiting.current) {
        // a reply finished while we weren't streaming it: refresh the week and profiles too
        wasWaiting.current = false;
        onChangedRef.current(["week", "profiles"]);
      }
      // the last word is still theirs and nobody's working on it: the reply never came
      const last = data.messages.at(-1);
      if (last?.role === "user" && Date.now() - new Date(last.createdAt.includes("T") ? last.createdAt : `${last.createdAt.replace(" ", "T")}Z`).getTime() > 5000) {
        setProblem({ message: "Sal didn't get to answer that one.", retry: true });
      }
    } catch {
      if (sendingRef.current) return;
      setLoadFailed(true);
      pollTimer.current = setTimeout(() => again.current(), POLL_MS * 3);
    }
  }, []);
  useEffect(() => {
    again.current = () => void resync();
  }, [resync]);

  useEffect(() => {
    // first load (the async work sets state once the history arrives)
    const first = setTimeout(() => void resync(), 0);
    return () => {
      clearTimeout(first);
      clearTimeout(pollTimer.current);
    };
  }, [resync]);

  // coming back to the app (or the tab) after a while: pick up anything that happened meanwhile
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && !sendingRef.current) void resync();
    };
    const onShow = (e: PageTransitionEvent) => e.persisted && !sendingRef.current && void resync();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onShow);
    window.addEventListener("online", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onShow);
      window.removeEventListener("online", onVisible);
    };
  }, [resync]);

  // follow new text unless the person scrolled up to read something
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, streaming, waiting, problem]);

  const onScroll = () => {
    const el = scroller.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  /** Send a message (or a follow-up with no text). Resolves false if it never reached Sal, so the draft can be restored. */
  const send = useCallback(
    async (text: string, attachments: string[] = [], voice = false, followUp = false): Promise<boolean> => {
      if (sendingRef.current) return false;
      sendingRef.current = true;
      clearTimeout(pollTimer.current);
      setWaiting(false);
      setProblem(null);
      stick.current = true;
      const tempId = -Date.now();
      if (!followUp) {
        setMessages((m) => [
          ...(m ?? []),
          { id: tempId, role: "user", content: text, createdAt: new Date().toISOString(), attachments, voice },
        ]);
      }
      setStreaming({ text: "", status: null });

      let accepted = false;
      let finished = false;
      const abort = new AbortController();
      let stall: ReturnType<typeof setTimeout> | undefined;
      const armStall = () => {
        clearTimeout(stall);
        stall = setTimeout(() => abort.abort(), STALL_MS);
      };

      try {
        armStall();
        const res = await fetch("/api/chat", { ...jsonInit("POST", { text, attachments, voice, followUp }), signal: abort.signal });
        if (res.status === 401) {
          window.location.assign("/login");
          return false;
        }
        if (!res.ok || !res.body) {
          setMessages((m) => (m ?? []).filter((x) => x.id !== tempId));
          const data = await res.json().catch(() => ({}));
          if (data.busy) {
            // a reply from earlier is still cooking; show it when it lands
            setProblem({ message: "Sal's still finishing your last message. Send this again when he's done.", retry: false });
            void resync();
          } else {
            setProblem({ message: data.error ?? "Sal didn't get that. Try again.", retry: false });
          }
          return false;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          armStall();
          buf += decoder.decode(value, { stream: true });
          let cut;
          while ((cut = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, cut);
            buf = buf.slice(cut + 2);
            if (!frame.startsWith("data: ")) continue; // keepalive comments
            const ev = JSON.parse(frame.slice(6));
            if (ev.type === "accepted") {
              accepted = true;
              if (ev.userMessageId) setMessages((m) => (m ?? []).map((x) => (x.id === tempId ? { ...x, id: ev.userMessageId } : x)));
            } else if (ev.type === "text") setStreaming((s) => ({ text: (s?.text ?? "") + ev.delta, status: null }));
            else if (ev.type === "status") setStreaming((s) => ({ text: s?.text ?? "", status: ev.label }));
            else if (ev.type === "error") {
              finished = true;
              setProblem({ message: ev.message, retry: Boolean(ev.retryable) });
            } else if (ev.type === "done") {
              finished = true;
              setMessages((m) => [
                ...(m ?? []).filter((x) => x.id !== ev.messageId),
                {
                  id: ev.messageId,
                  role: "assistant",
                  content: ev.text,
                  createdAt: new Date().toISOString(),
                  chips: ev.chips,
                  actions: ev.actions,
                  remembered: ev.remembered,
                },
              ]);
              if (ev.changed?.length) onChanged(ev.changed);
            }
          }
        }
        if (!finished) throw new Error("stream ended early");
        return true;
      } catch {
        if (!accepted) {
          // it never reached Sal: take the bubble back so the draft can be restored
          setMessages((m) => (m ?? []).filter((x) => x.id !== tempId));
          setProblem({ message: navigator.onLine ? "Couldn't reach Sal. Try again." : "You're offline. Send it again once you're connected.", retry: false });
          return false;
        }
        // Sal got it but the line dropped; his reply is still coming, so wait for it
        setStreaming(null);
        void resync();
        return true;
      } finally {
        clearTimeout(stall);
        setStreaming(null);
        sendingRef.current = false;
      }
    },
    [onChanged, resync],
  );

  async function decide(action: ActionView, approve: boolean) {
    setDeciding(action.id);
    setProblem(null);
    try {
      const res = await fetch(`/api/actions/${action.id}`, jsonInit("POST", { approve }));
      if (res.status === 401) return window.location.assign("/login");
      const r = (await res.json().catch(() => ({}))) as { action?: ActionView; changed?: string[]; error?: string };
      if (r.action) {
        setMessages((ms) =>
          (ms ?? []).map((m) => (m.actions ? { ...m, actions: m.actions.map((a) => (a.id === action.id ? r.action! : a)) } : m)),
        );
      } else {
        setProblem({ message: r.error ?? "That didn't work. Try again.", retry: false });
        void resync(); // e.g. someone already handled it on another phone
      }
      if (r.changed?.length) onChanged(r.changed);
      // let Sal react when a save fails, so the person isn't left looking at an error
      if (r.action?.status === "failed") void send("", [], false, true);
    } catch {
      setProblem({ message: "Couldn't reach the kitchen. Check your connection and tap again.", retry: false });
    } finally {
      setDeciding(null);
    }
  }

  const lastSal = [...(messages ?? [])].reverse().find((m) => m.role !== "event");
  const lastAssistant = lastSal?.role === "assistant" ? lastSal.id : undefined;

  return (
    <>
      <div className="chat" ref={scroller} onScroll={onScroll} aria-live="polite">
        {loadFailed && !messages && (
          <div className="empty-chat">
            <p>Couldn&apos;t load the chat. Retrying…</p>
            <button className="ghost" onClick={() => void resync()}>Try now</button>
          </div>
        )}
        {messages && !messages.length && !busy && (
          <div className="empty-chat">
            <img src="/icon.svg" alt="" />
            <p>Sal&apos;s in the kitchen. Ask him to plan this week, find something new, or tell him what you can&apos;t stand.</p>
            <div className="chips">
              {["Plan this week's dinners", "What's in our recipe box?", "Find me something new"].map((c) => (
                <button key={c} className="chip" style={{ color: "var(--forest)", borderColor: "var(--line)" }} onClick={() => void send(c)}>{c}</button>
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
                        <button className="yes" disabled={deciding === a.id || busy} onClick={() => decide(a, true)}>
                          {deciding === a.id
                            ? "Working…"
                            : a.kind === "import_recipe_url"
                              ? "Save it"
                              : a.kind === "remember"
                                ? "Remember it"
                                : a.kind === "forget"
                                  ? "Forget it"
                                  : "Yes, update"}
                        </button>
                        <button className="no" disabled={deciding === a.id || busy} onClick={() => decide(a, false)}>No thanks</button>
                      </div>
                    ) : (
                      <span className="done">
                        {a.status === "approved"
                          ? "Done."
                          : a.status === "declined"
                            ? "Skipped."
                            : a.status === "running"
                              ? "Working on it…"
                              : `Didn't work: ${a.result ?? "unknown problem"}`}
                      </span>
                    )}
                  </div>
                ))}
                {m.id === lastAssistant && !busy && !!m.chips?.length && (
                  <div className="chips">
                    {m.chips.map((c) => <button key={c} className="chip" onClick={() => void send(c)}>{c}</button>)}
                  </div>
                )}
              </div>
              {!!m.remembered?.length && <span className="remembered">Sal noted: {m.remembered.join("; ")}</span>}
            </div>
          ),
        )}

        {(streaming || waiting) && (
          <div className="msg sal">
            <span className="meta">Sal</span>
            <div className="bubble">
              {streaming?.text ? (
                <SalText text={hideRepliesLine(streaming.text)} />
              ) : (
                !streaming?.status && <span className="typing-dots" aria-label="Sal is typing"><i /><i /><i /></span>
              )}
              {streaming?.status && <span className="status">{streaming.status}</span>}
              {waiting && !streaming && <span className="status">Still working on it</span>}
            </div>
          </div>
        )}

        {problem && (
          <div className="problem" role="alert">
            <span>{problem.message}</span>
            {problem.retry && (
              <button className="ghost" onClick={() => void send("", [], false, true)} disabled={busy}>Try again</button>
            )}
          </div>
        )}
      </div>
      <Composer busy={busy} onSend={send} onKeyboard={onKeyboard} />
    </>
  );
}
