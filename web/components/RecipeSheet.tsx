"use client";

import "@/app/recipe.css";
import { Fragment, type ReactNode, useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { RecipeDetail, RecipeLine } from "@/lib/mealie";
import { findDurations, formatAmount, scaleLine } from "@/lib/scale";
import { XIcon } from "./icons";
import { api } from "./util";

type Timer = { id: number; key: string; label: string; endsAt: number; done: boolean };
type Section = { title?: string; items: { n: number; num: number; text: string }[] };

// when a recipe doesn't say how many it serves, the stepper scales by these instead
const MULTIPLIERS = [0.25, 0.5, 1, 1.5, 2, 3, 4];
const MAX_SERVINGS = 48;

const subscribeNothing = () => () => {};
/** False during the server render and hydration, true after, without a state flip in an effect. */
const useOnClient = () => useSyncExternalStore(subscribeNothing, () => true, () => false);

const pad = (n: number) => String(n).padStart(2, "0");
function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** Group lines under their headings, numbering the lines straight through. */
function sections(lines: RecipeLine[]): Section[] {
  const out: Section[] = [];
  let num = 0;
  lines.forEach((l, n) => {
    if (l.title || !out.length) out.push({ title: l.title, items: [] });
    if (l.text) out[out.length - 1].items.push({ n, num: ++num, text: l.text });
  });
  return out.filter((s) => s.title || s.items.length);
}

const toggled = (set: Set<number>, n: number) => {
  const next = new Set(set);
  if (!next.delete(n)) next.add(n);
  return next;
};

/** Keep Tab inside the sheet while it's open. */
function trapTab(e: KeyboardEvent, root: HTMLElement | null) {
  if (!root) return;
  const items = [...root.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')];
  if (!items.length) return e.preventDefault();
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (!root.contains(active) || (e.shiftKey && (active === first || active === root))) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

/** Three short beeps. The context was unlocked by the tap that started the timer. */
function beep(ctx: AudioContext | null) {
  if (!ctx) return;
  void ctx.resume().catch(() => {});
  const t = ctx.currentTime + 0.05;
  for (let i = 0; i < 3; i++) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    const at = t + i * 0.32;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.35, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.25);
  }
}

function useTimers() {
  const [timers, setTimers] = useState<Timer[]>([]);
  const [now, setNow] = useState(0);
  const handles = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const audio = useRef<AudioContext | null>(null);
  const nextId = useRef(1);

  const running = timers.some((t) => !t.done);
  useEffect(() => {
    if (!running) return;
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(tick);
  }, [running]);

  useEffect(() => {
    const pending = handles.current;
    return () => {
      pending.forEach(clearTimeout);
      pending.clear();
      void audio.current?.close().catch(() => {});
    };
  }, []);

  const finish = useCallback((id: number) => {
    handles.current.delete(id);
    setNow(Date.now());
    setTimers((ts) => ts.map((t) => (t.id === id ? { ...t, done: true } : t)));
    navigator.vibrate?.([300, 150, 300, 150, 300]);
    beep(audio.current);
  }, []);

  function start(key: string, label: string, seconds: number) {
    if (timers.some((t) => t.key === key && !t.done)) return;
    // iOS only plays sound from a context first started during a tap, so start it now
    if (!audio.current && typeof AudioContext !== "undefined") audio.current = new AudioContext();
    void audio.current?.resume().catch(() => {});
    const id = nextId.current++;
    const t0 = Date.now();
    setNow(t0);
    setTimers((ts) => [...ts.filter((t) => t.key !== key), { id, key, label, endsAt: t0 + seconds * 1000, done: false }]);
    handles.current.set(id, setTimeout(() => finish(id), seconds * 1000));
  }

  function cancel(id: number) {
    clearTimeout(handles.current.get(id));
    handles.current.delete(id);
    setTimers((ts) => ts.filter((t) => t.id !== id));
  }

  return { timers, now, start, cancel };
}

const wakeLockSupported = () => "wakeLock" in navigator;

function useWakeLock() {
  const supported = useSyncExternalStore(subscribeNothing, wakeLockSupported, () => false);
  const [on, setOn] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!on) return;
    let lock: WakeLockSentinel | null = null;
    let live = true;
    const grab = async () => {
      if (document.visibilityState !== "visible" || (lock && !lock.released)) return;
      try {
        const l = await navigator.wakeLock.request("screen");
        if (live) lock = l;
        else void l.release();
      } catch {
        if (!live) return;
        setOn(false);
        setNote("Couldn't keep the screen on. Battery saver may be blocking it.");
      }
    };
    void grab();
    // the browser drops the lock whenever the app is hidden, so take it back on return
    document.addEventListener("visibilitychange", grab);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", grab);
      void lock?.release().catch(() => {});
    };
  }, [on]);

  const toggle = () => {
    setNote("");
    setOn((v) => !v);
  };
  return { supported, on, toggle, note };
}

const TimerIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="13" r="8" /><path d="M12 9v4l2.5 2M9.5 2.5h5" />
  </svg>
);
const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);

export default function RecipeSheet({ slug, onClose }: { slug: string; onClose: () => void }) {
  const onClient = useOnClient();
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  // focus moves in on open and back to whatever opened the sheet on close; the page behind holds still
  useEffect(() => {
    if (!onClient) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
      } else if (e.key === "Tab") {
        trapTab(e, panel.current);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      opener?.focus();
    };
  }, [onClient]);

  if (!onClient) return null;
  // portaled to <body> so a tilted or scrolling parent (the week ticket) can't trap the fixed sheet
  return createPortal(
    <div className="rs-root">
      <div className="rs-scrim" onClick={onClose} aria-hidden="true" />
      <div className="rs" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={panel} tabIndex={-1}>
        <Card key={slug} slug={slug} onClose={onClose} titleId={titleId} />
      </div>
    </div>,
    document.body,
  );
}

function Card({ slug, onClose, titleId }: { slug: string; onClose: () => void; titleId: string }) {
  const [recipe, setRecipe] = useState<RecipeDetail | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [people, setPeople] = useState<number | null>(null);
  const [multIndex, setMultIndex] = useState(MULTIPLIERS.indexOf(1));
  const [checked, setChecked] = useState<Set<number>>(() => new Set());
  const [doneSteps, setDoneSteps] = useState<Set<number>>(() => new Set());
  const [photoFailed, setPhotoFailed] = useState(false);
  const { timers, now, start, cancel } = useTimers();
  const wake = useWakeLock();

  useEffect(() => {
    let live = true;
    api<RecipeDetail>(`/api/recipes/${encodeURIComponent(slug)}`).then(
      (r) => live && setRecipe(r),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [slug, attempt]);

  const retry = () => {
    setError("");
    setAttempt((n) => n + 1);
  };

  const bar = (
    <div className="rs-top">
      <div className="rs-bar">
        {wake.supported && (
          <button type="button" className="rs-wake" role="switch" aria-checked={wake.on} onClick={wake.toggle}>
            <span className="rs-switch" aria-hidden="true" />
            Keep screen on
          </button>
        )}
        <span className="rs-bar-name" aria-hidden="true">{recipe?.name}</span>
        <button type="button" className="rs-close" onClick={onClose} aria-label="Close recipe">
          <XIcon />
        </button>
      </div>
      {wake.note && <p className="rs-wake-note" role="status">{wake.note}</p>}
      {timers.length > 0 && (
        <ul className="rs-timers" aria-label="Timers">
          {timers.map((t) => (
            <li key={t.id} className={t.done ? "done" : undefined}>
              <TimerIcon />
              <span className="rs-t-label">{t.label}</span>
              <span className="rs-t-clock">{t.done ? "Done" : clock(t.endsAt - now)}</span>
              <button type="button" onClick={() => cancel(t.id)} aria-label={t.done ? `Dismiss ${t.label} timer` : `Cancel ${t.label} timer`}>
                <XIcon />
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="sr-only" aria-live="assertive">
        {timers.filter((t) => t.done).map((t) => `${t.label} timer is done.`).join(" ")}
      </p>
    </div>
  );

  if (!recipe) {
    return (
      <>
        {bar}
        <div className="rs-state">
          <h2 id={titleId}>{error ? "Couldn't pull that recipe card. Try again." : "Pulling the recipe card…"}</h2>
          {error && (
            <>
              {!error.startsWith("Couldn't pull") && <p>{error}</p>}
              <button type="button" className="push" onClick={retry}>Try again</button>
            </>
          )}
        </div>
      </>
    );
  }

  const known = recipe.servings;
  const target = known ? (people ?? known) : null;
  const factor = known && target ? target / known : MULTIPLIERS[multIndex];
  const scaled = factor !== 1;
  const amountLabel = target ? `${target} serving${target === 1 ? "" : "s"}` : `×${formatAmount(factor)}`;
  const canLess = target ? target > 1 : multIndex > 0;
  const canMore = target ? target < MAX_SERVINGS : multIndex < MULTIPLIERS.length - 1;
  const less = () => (target ? setPeople(target - 1) : setMultIndex((i) => i - 1));
  const more = () => (target ? setPeople(target + 1) : setMultIndex((i) => i + 1));
  const reset = () => {
    setPeople(null);
    setMultIndex(MULTIPLIERS.indexOf(1));
  };

  const times = [
    ["Prep", recipe.times.prep],
    ["Cook", recipe.times.cook],
    ["Total", recipe.times.total],
  ].filter((t): t is [string, string] => Boolean(t[1]));

  const toggleStep = (n: number) => setDoneSteps((s) => toggled(s, n));

  return (
    <>
      {bar}
      <article className="rs-card">
        {recipe.hasImage && !photoFailed && (
          <img className="rs-photo" src={`/api/recipes/${encodeURIComponent(recipe.slug)}/image`} alt="" onError={() => setPhotoFailed(true)} />
        )}
        <header className="rs-head">
          <small className="rs-kicker">FROM THE BOX</small>
          <h2 id={titleId}>{recipe.name}</h2>
          {recipe.description && <p className="rs-desc">{recipe.description}</p>}
          {(times.length > 0 || known || recipe.makes) && (
            <dl className="rs-meta">
              {times.map(([label, value]) => (
                <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
              ))}
              {known && <div><dt>Serves</dt><dd>{known}</dd></div>}
              {recipe.makes && <div><dt>Makes</dt><dd>{recipe.makes}</dd></div>}
            </dl>
          )}
        </header>

        <div className="rs-cols">
          <section className="rs-ings" aria-labelledby={`${titleId}-ing`}>
            <h3 id={`${titleId}-ing`}>Ingredients</h3>
            <div className="rs-stepper" role="group" aria-label={known ? "Servings" : "Batch size"}>
              <button type="button" onClick={less} disabled={!canLess} aria-label={known ? "Fewer servings" : "Smaller batch"}>−</button>
              <output aria-live="polite">{amountLabel}</output>
              <button type="button" onClick={more} disabled={!canMore} aria-label={known ? "More servings" : "Bigger batch"}>+</button>
              {scaled && <button type="button" className="rs-reset" onClick={reset}>As written</button>}
            </div>
            {recipe.ingredients.length === 0 && <p className="rs-none">No ingredients on this card.</p>}
            {sections(recipe.ingredients).map((sec, si) => (
              <Fragment key={si}>
                {sec.title && <h4>{sec.title}</h4>}
                <ul>
                  {sec.items.map((it) => {
                    const on = checked.has(it.n);
                    return (
                      <li key={it.n}>
                        <button type="button" className="rs-ing" role="checkbox" aria-checked={on} onClick={() => setChecked((s) => toggled(s, it.n))}>
                          <span className="rs-box" aria-hidden="true">{on && <CheckIcon />}</span>
                          <span>{scaleLine(it.text, factor)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </Fragment>
            ))}
          </section>

          <section className="rs-steps" aria-labelledby={`${titleId}-steps`}>
            <h3 id={`${titleId}-steps`}>Method</h3>
            {recipe.steps.length === 0 && <p className="rs-none">No steps on this card. Open it in Mealie to check.</p>}
            {sections(recipe.steps).map((sec, si) => (
              <Fragment key={si}>
                {sec.title && <h4>{sec.title}</h4>}
                <ol>
                  {sec.items.map((it) => {
                    const done = doneSteps.has(it.n);
                    return (
                      <li key={it.n} className={done ? "done" : undefined}>
                        <button type="button" className="rs-num" role="checkbox" aria-checked={done} aria-label={`Step ${it.num} done`} onClick={() => toggleStep(it.n)}>
                          {done ? <CheckIcon /> : it.num}
                        </button>
                        {/* tapping the words marks the step too; the number button is the keyboard way */}
                        <p onClick={() => toggleStep(it.n)}>
                          <StepText text={it.text} num={it.num} timers={timers} now={now} onStart={start} />
                        </p>
                      </li>
                    );
                  })}
                </ol>
              </Fragment>
            ))}
          </section>
        </div>

        {recipe.notes.length > 0 && (
          <section className="rs-notes">
            <h3>Notes</h3>
            {recipe.notes.map((n, i) => (
              <p key={i}>{n.title && <b>{n.title}. </b>}{n.text}</p>
            ))}
          </section>
        )}

        {recipe.nutrition.length > 0 && (
          <section className="rs-nutrition">
            <h3>Per serving</h3>
            <dl>
              {recipe.nutrition.map((n) => (
                <div key={n.label}><dt>{n.label}</dt><dd>{n.value}</dd></div>
              ))}
            </dl>
          </section>
        )}

        <footer className="rs-links">
          <a href={recipe.mealieUrl} target="_blank" rel="noreferrer">Open in Mealie</a>
          {recipe.sourceUrl && <a href={recipe.sourceUrl} target="_blank" rel="noreferrer noopener">Original recipe</a>}
        </footer>
      </article>
    </>
  );
}

/** Step text with each cooking time ("10 minutes") turned into a tap-to-start timer. */
function StepText({
  text,
  num,
  timers,
  now,
  onStart,
}: {
  text: string;
  num: number;
  timers: Timer[];
  now: number;
  onStart: (key: string, label: string, seconds: number) => void;
}) {
  const parts: ReactNode[] = [];
  let at = 0;
  findDurations(text).forEach((d, i) => {
    parts.push(text.slice(at, d.start));
    const key = `${num}:${i}`;
    const t = timers.find((x) => x.key === key);
    const running = t && !t.done;
    parts.push(
      <button
        key={key}
        type="button"
        className={`rs-chip${running ? " on" : t?.done ? " done" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          onStart(key, `Step ${num}, ${d.label}`, d.seconds);
        }}
        aria-label={running ? `${d.label} timer, ${clock(t.endsAt - now)} left` : `Start a timer for ${d.label}`}
      >
        <TimerIcon />
        {running ? clock(t.endsAt - now) : d.label}
      </button>,
    );
    at = d.end;
  });
  parts.push(text.slice(at));
  return <>{parts}</>;
}
