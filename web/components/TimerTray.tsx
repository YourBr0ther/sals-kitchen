"use client";

import { XIcon } from "./icons";
import { cancelTimer, clock, useTimers } from "./timers";

/** Running and finished cooking timers, shown over the app while no recipe card is open. */
export default function TimerTray({ onOpen }: { onOpen: (slug: string) => void }) {
  const { timers, now } = useTimers();
  if (!timers.length) return null;
  return (
    <div className="timer-tray" role="region" aria-label="Cooking timers">
      {timers.map((t) => (
        <div key={t.id} className={`tt${t.done ? " done" : ""}`}>
          <button className="tt-open" onClick={() => onOpen(t.slug)} aria-label={`${t.recipe}, ${t.label}${t.done ? ", done" : `, ${clock(t.endsAt - now)} left`}. Open the recipe`}>
            <span className="tt-clock">{t.done ? "Done" : clock(t.endsAt - now)}</span>
            <span className="tt-what">{t.recipe} <small>{t.label}</small></span>
          </button>
          <button className="tt-x" onClick={() => cancelTimer(t.id)} aria-label={t.done ? "Dismiss timer" : "Cancel timer"}><XIcon /></button>
        </div>
      ))}
      <p className="sr-only" aria-live="assertive">{timers.filter((t) => t.done).map((t) => `${t.recipe}: ${t.label} is done.`).join(" ")}</p>
    </div>
  );
}
