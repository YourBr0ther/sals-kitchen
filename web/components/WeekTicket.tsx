"use client";

import { useState } from "react";
import type { User } from "@/lib/db";
import type { Night, Week } from "@/lib/week";
import { XIcon } from "./icons";
import { api, jsonInit } from "./util";

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
  onPrev,
  onNext,
  onThisWeek,
}: {
  me: User;
  week: Week | null;
  setWeek: (w: Week) => void;
  onPrev: () => void;
  onNext: () => void;
  onThisWeek: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState("");

  if (!week) {
    return (
      <>
        <div className="rail-bar" />
        <article className="ticket"><header><b>THE WEEK</b><small>Pulling the ticket…</small></header></article>
      </>
    );
  }

  async function patch(n: Night, body: object) {
    try {
      setWeek(await api<Week>("/api/week", jsonInit("PATCH", { date: n.date, ...body })));
    } catch (e) {
      setNote((e as Error).message);
    }
  }

  async function send() {
    if (!week) return;
    setSending(true);
    setNote("");
    try {
      const r = await api<{ sent: number; skipped: string[]; week: Week }>("/api/week/send", jsonInit("POST", { start: week.start }));
      setWeek(r.week);
      setNote(
        `Sent ${r.sent} dinner${r.sent === 1 ? "" : "s"} to Mealie.` +
          (r.skipped.length ? ` ${r.skipped.join(", ")} still ${r.skipped.length === 1 ? "needs" : "need"} a meal.` : ""),
      );
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setSending(false);
    }
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
                <button aria-label={`Clear ${n.day}'s meal`} onClick={() => patch(n, { clear: true })}><XIcon /></button>
              )}
              <button
                aria-label={n.cooking ? `Mark ${n.day} as no cooking` : `Mark ${n.day} as a cooking night`}
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
