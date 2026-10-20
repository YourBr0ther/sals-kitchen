"use client";

import ReactMarkdown from "react-markdown";
import type { ActionView, VisibleMessage } from "@/lib/chat";
import type { User } from "@/lib/db";
import { MicIcon, SpeakerIcon } from "./icons";
import { timeLabel } from "./util";

// Mealie recipe pages look like /g/<group>/r/<slug>; those open in the app's own recipe view
const MEALIE_RECIPE = /\/g\/[^/]+\/r\/([a-z0-9-]+)\/?$/;

export function SalText({ text, onOpenRecipe }: { text: string; onOpenRecipe?: (slug: string) => void }) {
  return (
    <ReactMarkdown
      components={{
        a: ({ href, children }) => {
          const slug = href?.match(MEALIE_RECIPE)?.[1];
          return (
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              onClick={(e) => {
                if (slug && onOpenRecipe) {
                  e.preventDefault();
                  onOpenRecipe(slug);
                }
              }}
            >
              {children}
            </a>
          );
        },
        img: () => null,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

const APPROVE_LABEL: Record<string, string> = {
  import_recipe_url: "Save it",
  import_recipe: "Save it",
  remember: "Remember it",
  forget: "Forget it",
  make_grocery_list: "Make the list",
  update_pantry: "Yes, update",
  log_dinner: "Save it",
};

function ActionResult({ a }: { a: ActionView }) {
  if (a.status === "approved") {
    // the grocery list lives in Mealie; link straight to it
    const url = a.kind === "make_grocery_list" ? a.result?.match(/\((https?:\/\/[^)\s]+)\)/)?.[1] : undefined;
    return (
      <span className="done">
        Done.{url && <> <a href={url} target="_blank" rel="noreferrer noopener">Open the list in Mealie</a></>}
      </span>
    );
  }
  if (a.status === "declined") return <span className="done">Skipped.</span>;
  if (a.status === "running") return <span className="done">Working on it…</span>;
  return <span className="done">Didn&apos;t work: {a.result ?? "unknown problem"}</span>;
}

export interface MessageHandlers {
  /** approve or decline a request card; omitted in read-only views */
  onDecide?: (a: ActionView, approve: boolean) => void;
  onChip?: (text: string) => void;
  onSpeak?: (m: VisibleMessage) => void;
  onOpenRecipe?: (slug: string) => void;
  deciding?: number | null;
  busy?: boolean;
  speaking?: number | null;
  /** chips only show under this message (the latest reply) */
  chipsFor?: number;
}

export function MessageList({ messages, me, ...h }: { messages: VisibleMessage[]; me: User } & MessageHandlers) {
  return (
    <>
      {messages.map((m) =>
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
            <span className="meta">
              Sal, {timeLabel(m.createdAt)}
              {h.onSpeak && m.id > 0 && (
                <button
                  className={`speak${h.speaking === m.id ? " on" : ""}`}
                  aria-label={h.speaking === m.id ? "Stop reading" : "Read this out loud"}
                  aria-pressed={h.speaking === m.id}
                  onClick={() => h.onSpeak!(m)}
                >
                  <SpeakerIcon />
                </button>
              )}
            </span>
            <div className="bubble">
              <SalText text={m.content} onOpenRecipe={h.onOpenRecipe} />
              {m.actions?.map((a) => (
                <div key={a.id} className="action-card">
                  <p>{a.summary}?</p>
                  {a.status === "pending" && h.onDecide ? (
                    <div className="row">
                      <button className="yes" disabled={h.deciding === a.id || h.busy} onClick={() => h.onDecide!(a, true)}>
                        {h.deciding === a.id ? "Working…" : (APPROVE_LABEL[a.kind] ?? "Yes, update")}
                      </button>
                      <button className="no" disabled={h.deciding === a.id || h.busy} onClick={() => h.onDecide!(a, false)}>No thanks</button>
                    </div>
                  ) : a.status === "pending" ? (
                    <span className="done">Never answered.</span>
                  ) : (
                    <ActionResult a={a} />
                  )}
                </div>
              ))}
              {m.id === h.chipsFor && !h.busy && !!m.chips?.length && h.onChip && (
                <div className="chips">
                  {m.chips.map((c) => <button key={c} className="chip" onClick={() => h.onChip!(c)}>{c}</button>)}
                </div>
              )}
            </div>
            {!!m.remembered?.length && <span className="remembered">Sal noted: {m.remembered.join("; ")}</span>}
          </div>
        ),
      )}
    </>
  );
}
