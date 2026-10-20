"use client";

import { useCallback, useEffect, useState } from "react";
import type { ConversationSummary, VisibleMessage } from "@/lib/chat";
import type { User } from "@/lib/db";
import { MessageList } from "./Messages";
import { useSpeaker } from "./speech";
import { api } from "./util";

const day = (sqlite: string) =>
  new Date(`${sqlite.replace(" ", "T")}Z`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });

/** Earlier conversations with Sal, newest first, read-only. Only the signed-in person's. */
export default function PastConversations({ me, onClose, onOpenRecipe }: { me: User; onClose: () => void; onOpenRecipe: (slug: string) => void }) {
  const [list, setList] = useState<ConversationSummary[] | null>(null);
  const [open, setOpen] = useState<{ c: ConversationSummary; messages: VisibleMessage[] } | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const { speaking, speak, stop } = useSpeaker();

  const [searched, setSearched] = useState(false);
  // the conversation being opened, so a slow phone shows something happening and a retry reopens it
  const [opening, setOpening] = useState<ConversationSummary | null>(null);

  const load = useCallback(async (q = "") => {
    try {
      setError("");
      setList((await api<{ conversations: ConversationSummary[] }>(`/api/conversations${q ? `?q=${encodeURIComponent(q)}` : ""}`)).conversations);
      setSearched(Boolean(q));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // searches the whole conversations, not just the first line; waits for a pause in typing
  useEffect(() => {
    const t = setTimeout(() => void load(filter.trim()), filter ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, filter]);

  async function show(c: ConversationSummary) {
    setOpening(c);
    try {
      setError("");
      const r = await api<{ messages: VisibleMessage[] }>(`/api/conversations/${c.through}`);
      setOpen({ c, messages: r.messages });
      setOpening(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }


  return (
    <section className="past" aria-label="Earlier conversations">
      <div className="past-head">
        <button className="ghost" onClick={open ? () => (stop(), setOpen(null)) : onClose}>{open ? "All conversations" : "Back to chat"}</button>
        <h2>{open ? `${day(open.c.startedAt)}` : "Earlier conversations"}</h2>
      </div>
      {error && (
        <p className="error-line" role="alert">
          {error} <button className="ghost" onClick={() => void (opening ? show(opening) : load(filter.trim()))}>Try again</button>
        </p>
      )}
      {open ? (
        <div className="chat past-chat">
          <MessageList
            messages={open.messages}
            me={me}
            onOpenRecipe={onOpenRecipe}
            onSpeak={(m) => (speaking === m.id ? stop() : void speak(m.id, m.content))}
            speaking={speaking}
          />
        </div>
      ) : (
        <div className="past-list">
          {list && (list.length > 4 || searched) && (
            <input className="past-filter" type="search" placeholder="Find a conversation" aria-label="Find a conversation" value={filter} onChange={(e) => setFilter(e.target.value)} />
          )}
          {list === null && !error && <p className="none">Loading…</p>}
          {list && !list.length && (
            <p className="none">{searched ? "Nothing matches that." : "No earlier conversations yet. They show up here after you start a new one."}</p>
          )}
          <ul>
            {list?.map((c) => (
              <li key={c.through}>
                <button onClick={() => void show(c)} aria-busy={opening?.through === c.through} disabled={opening?.through === c.through && !error}>
                  <span className="when">{day(c.startedAt)}</span>
                  <span className="what">{c.preview}</span>
                  <small>{c.messages} messages</small>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
