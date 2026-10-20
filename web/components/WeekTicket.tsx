"use client";

import { useState } from "react";
import type { User } from "@/lib/db";
import type { Night, Week } from "@/lib/week";
import { XIcon } from "./icons";
import { jsonInit } from "./util";

const fmt = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const OnOffIcon = ({ on }: { on: boolean }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
    {on ? <path d="M5 12l4 4 10-10" /> : <><circle cx="12" cy="12" r="8" /><path d="M6.5 17.5l11-11" /></>}
  </svg>
);

export default function WeekTicket({
  me,
  week,
  setWeek,
  loadError,
  onRetry,
  onPrev,
  onNext,
  onThisWeek,
}: {
  me: User;
  week: Week | null;
  setWeek: (w: Week) => void;
  loadError: string;
  onRetry: () => void;
  onPrev: () => void;
  onNext: () => void;
  onThisWeek: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [changing, setChanging] = useState<string | null>(null);
  const [note, setNote] = useState("");

  if (!week) {
    return (
      <>
        <div className="rail-bar" />
        <article className="ticket">
          <header><b>THE WEEK</b><small>{loadError ? "Couldn't pull the ticket." : "Pulling the ticket…"}</small></header>
          {loadError && (
            <footer>
              <p className="msgline" role="alert">{loadError}</p>
              <button className="push" onClick={onRetry}>Try again</button>
            </footer>
          )}
        </article>
      </>
    );
  }

  /** POST/PATCH that hands back the server's error and, when there is one, the up-to-date week. */
  async function request(url: string, init: RequestInit): Promise<{ ok: boolean; data: Record<string, unknown> }> {
    try {
      const res = await fetch(url, init);
      if (res.status === 401) window.location.assign("/login");
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (data.week) setWeek(data.week as Week);
      return { ok: res.ok, data };
    } catch {
      return { ok: false, data: { error: navigator.onLine ? "Couldn't reach the kitchen. Try again." : "You're offline. Try again once you're connected." } };
    }
  }

  async function patch(n: Night, body: object) {
    if (changing) return;
    setChanging(n.date);
    setNote("");
    const r = await request("/api/week", jsonInit("PATCH", { date: n.date, ...body }));
    if (r.ok) setWeek(r.data as unknown as Week);
    else setNote(String(r.data.error ?? "Couldn't change that night. Try again."));
    setChanging(null);
  }

  async function send() {
    if (!week || sending) return;
    setSending(true);
    setNote("");
    const r = await request("/api/week/send", jsonInit("POST", { start: week.start }));
    if (r.ok) {
      const sent = Number(r.data.sent ?? 0);
      const skipped = (r.data.skipped as string[]) ?? [];
      setNote(
        `Sent ${sent} dinner${sent === 1 ? "" : "s"} to Mealie.` +
          (skipped.length ? ` ${skipped.join(", ")} still ${skipped.length === 1 ? "needs" : "need"} a meal.` : ""),
      );
    } else {
      setNote(String(r.data.error ?? "Couldn't send the week. Try again."));
    }
    setSending(false);
  }

  const cooking = week.nights.filter((n) => n.cooking).length;
  const planned = week.nights.filter((n) => n.cooking && n.title).length;
  const allSent = planned > 0 && week.nights.every((n) => !n.cooking || !n.title || n.sentToMealie);

  return (
    <>
      <div className="rail-bar" />
      <article className="ticket" aria-label={`Week of ${fmt(week.start)}`}>
        <header>
          <b>THE WEEK</b>
          <small>{fmt(week.start)} to {fmt(week.end)}</small>
          <div className="weeknav">
            <button onClick={onPrev} aria-label="Previous week">&lt; prev</button>
            <button onClick={onThisWeek}>today</button>
            <button onClick={onNext} aria-label="Next week">next &gt;</button>
          </div>
        </header>
        {week.nights.map((n) => (
          <div key={n.date} className={`night${n.cooking ? "" : " off"}`}>
            <span className="d">{n.day}<small>{fmt(n.date).split(" ")[1]}</small></span>
            <span className="what">
              {n.title ? (
                <span>
                  {n.sourceUrl && !n.recipeSlug ? <a href={n.sourceUrl} target="_blank" rel="noreferrer">{n.title}</a> : n.title}
                </span>
              ) : n.cooking ? (
                <span className="open">Open</span>
              ) : (
                <span>No cooking</span>
              )}
              {(n.busy.length > 0 || n.note) && <small>{[n.busy.join(", "), n.note].filter(Boolean).join(" / ")}</small>}
              {n.title && (
                <small>
                  {n.sentToMealie ? <span className="tag sent">in Mealie</span> : n.recipeSlug ? <span className="tag box">in box</span> : <span className="tag new">new</span>}
                </small>
              )}
            </span>
            <span className="acts">
              {n.title && (
                <button aria-label={`Clear ${n.day}'s meal`} disabled={changing === n.date} onClick={() => patch(n, { clear: true })}><XIcon /></button>
              )}
              <button
                aria-label={n.cooking ? `Mark ${n.day} as no cooking` : `Mark ${n.day} as a cooking night`}
                disabled={changing === n.date}
                onClick={() => patch(n, { cooking: !n.cooking })}
              >
                <OnOffIcon on={!n.cooking} />
              </button>
            </span>
          </div>
        ))}
        <footer>
          <div className="total"><span>Cooking nights</span><b>{cooking} of 7</b></div>
          {!week.calendar.configured && <span className="cal-note">No calendar connected yet. Tap a night to mark it off.</span>}
          {week.calendar.error && <span className="cal-note">Calendar trouble: {week.calendar.error}</span>}
          {me.role === "adult" && (
            <button className="push" onClick={send} disabled={sending || planned === 0}>
              {sending ? "Sending…" : allSent ? "Sent. Send again" : "Send to Mealie"}
            </button>
          )}
          {note && <p className="msgline" role="status">{note}</p>}
        </footer>
      </article>
    </>
  );
}
