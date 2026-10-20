"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ActionView, VisibleMessage } from "@/lib/chat";
import type { User } from "@/lib/db";
import type { Settings } from "@/lib/settings";
import Composer from "./Composer";
import { ClockIcon, XIcon } from "./icons";
import { MessageList, SalText } from "./Messages";
import { useSpeaker } from "./speech";
import { jsonInit } from "./util";

type Streaming = { text: string; status: string | null };
type Problem = { message: string; retry: boolean };
type Ask = { date: string; day: string; title: string };

const ANSWERS = [
  { verdict: "loved", label: "Loved it" },
  { verdict: "fine", label: "It was fine" },
  { verdict: "not_again", label: "Not again" },
  { verdict: "skipped", label: "Didn't make it" },
] as const;

const hideRepliesLine = (t: string) => t.replace(/\n*\s*replies:[^\n]*$/i, "");

// the server sends a keepalive every 15s; this much silence means the connection died
const STALL_MS = 40_000;
const POLL_MS = 3_000;

async function fetchHistory(): Promise<{ messages: VisibleMessage[]; busy: boolean; hasPast: boolean }> {
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
  onOpenRecipe,
  onShowPast,
  readAloud,
}: {
  me: User;
  onChanged: (changed: string[]) => void;
  onKeyboard: (open: boolean) => void;
  onBusy: (busy: boolean) => void;
  onOpenRecipe: (slug: string) => void;
  onShowPast: () => void;
  readAloud: Settings["readAloud"];
}) {
  const [messages, setMessages] = useState<VisibleMessage[] | null>(null);
  const [streaming, setStreaming] = useState<Streaming | null>(null);
  // Sal is answering, but this screen lost the live stream (app backgrounded, signal dropped)
  const [waiting, setWaiting] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [deciding, setDeciding] = useState<number | null>(null);
  const [hasPast, setHasPast] = useState(false);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [answering, setAnswering] = useState(false);
  const { speaking, speak, stop: stopSpeaking } = useSpeaker();
  const readAloudRef = useRef(readAloud);
  useEffect(() => {
    readAloudRef.current = readAloud;
  }, [readAloud]);
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
      setHasPast(data.hasPast);
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

  /** The dinner to ask about, if there's one this person hasn't answered. */
  const loadAsk = useCallback(async () => {
    try {
      const res = await fetch("/api/feedback", { cache: "no-store" });
      if (res.ok) setAsk(((await res.json()) as { ask: Ask | null }).ask);
    } catch {
      // the card is a nicety; no card is fine
    }
  }, []);

  useEffect(() => {
    // first load (the async work sets state once the history arrives)
    const first = setTimeout(() => {
      void resync();
      void loadAsk();
    }, 0);
    return () => {
      clearTimeout(first);
      clearTimeout(pollTimer.current);
    };
  }, [resync, loadAsk]);

  // coming back to the app (or the tab) after a while: pick up anything that happened meanwhile
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && !sendingRef.current) {
        void resync();
        void loadAsk();
      }
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
  }, [resync, loadAsk]);

  // follow new text unless the person scrolled up to read something
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, streaming, waiting, problem, ask]);

  const onScroll = () => {
    const el = scroller.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  /** Send a message (or a follow-up with no text). Resolves false if it never reached Sal, so the draft can be restored. */
  const send = useCallback(
    async (text: string, attachments: string[] = [], voice = false, followUp = false): Promise<boolean> => {
      if (sendingRef.current) return false;
      sendingRef.current = true;
      stopSpeaking();
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
              const mode = readAloudRef.current;
              if (mode === "always" || (mode === "voice" && voice)) void speak(ev.messageId, ev.text);
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
    [onChanged, resync, speak, stopSpeaking],
  );

  async function stopSal() {
    try {
      await fetch("/api/chat/stop", { method: "POST" });
    } catch {
      setProblem({ message: "Couldn't reach the kitchen to stop him. Check your connection.", retry: false });
    }
  }

  async function answer(verdict: string) {
    if (!ask || answering) return;
    setAnswering(true);
    try {
      const res = await fetch("/api/feedback", jsonInit("POST", { date: ask.date, verdict }));
      const r = (await res.json().catch(() => ({}))) as { event?: number | null; warning?: string | null; error?: string };
      if (!res.ok) {
        setProblem({ message: r.error ?? "Couldn't save that. Try again.", retry: false });
        return;
      }
      setAsk(null);
      onChanged(["week"]);
      if (r.warning) setProblem({ message: r.warning, retry: false });
      // Sal hears about it and answers; the event shows up in the chat with his reply
      if (r.event) {
        await resync();
        void send("", [], false, true);
      }
      void loadAsk();
    } catch {
      setProblem({ message: "Couldn't reach the kitchen. Check your connection and tap again.", retry: false });
    } finally {
      setAnswering(false);
    }
  }

  function toggleSpeak(m: VisibleMessage) {
    if (speaking === m.id) stopSpeaking();
    else void speak(m.id, m.content);
  }

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
        {hasPast && (
          <button className="past-link" onClick={onShowPast}><ClockIcon />Earlier conversations</button>
        )}
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
                <button key={c} className="chip" style={{ color: "var(--accent)", borderColor: "var(--line)" }} onClick={() => void send(c)}>{c}</button>
              ))}
            </div>
          </div>
        )}

        {messages && (
          <MessageList
            messages={messages}
            me={me}
            onDecide={decide}
            onChip={(c) => void send(c)}
            onSpeak={toggleSpeak}
            onOpenRecipe={onOpenRecipe}
            deciding={deciding}
            busy={busy}
            speaking={speaking}
            chipsFor={lastAssistant}
          />
        )}

        {(streaming || waiting) && (
          <div className="msg sal">
            <span className="meta">Sal</span>
            <div className="bubble">
              {streaming?.text ? (
                <SalText text={hideRepliesLine(streaming.text)} onOpenRecipe={onOpenRecipe} />
              ) : (
                !streaming?.status && <span className="typing-dots" aria-label="Sal is typing"><i /><i /><i /></span>
              )}
              {streaming?.status && <span className="status">{streaming.status}</span>}
              {waiting && !streaming && <span className="status">Still working on it</span>}
            </div>
          </div>
        )}

        {ask && !busy && (
          <div className="ask-card" role="group" aria-label={`How was ${ask.day}'s dinner?`}>
            <button className="ask-x" aria-label="Don't ask about this one" disabled={answering} onClick={() => void answer("dismissed")}><XIcon /></button>
            <p>How was {ask.day}&apos;s <b>{ask.title}</b>?</p>
            <div className="ask-row">
              {ANSWERS.map((a) => (
                <button key={a.verdict} disabled={answering} onClick={() => void answer(a.verdict)}>{a.label}</button>
              ))}
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
      <Composer busy={busy} onSend={send} onStop={() => void stopSal()} onKeyboard={onKeyboard} />
    </>
  );
}
