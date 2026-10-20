"use client";

import "@/app/recipe.css";
import { Fragment, type ReactNode, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { RecipeDetail, RecipeLine } from "@/lib/mealie";
import { findDurations, formatAmount, scaleLine } from "@/lib/scale";
import { XIcon } from "./icons";
import { cancelTimer, clock, startTimer, type Timer, useTimers } from "./timers";
import { api, jsonInit } from "./util";
import type { Week } from "@/lib/week";

type Section = { title?: string; items: { n: number; num: number; text: string }[] };

// when a recipe doesn't say how many it serves, the stepper scales by these instead
const MULTIPLIERS = [0.25, 0.5, 1, 1.5, 2, 3, 4];
const MAX_SERVINGS = 48;

const subscribeNothing = () => () => {};
/** False during the server render and hydration, true after, without a state flip in an effect. */
const useOnClient = () => useSyncExternalStore(subscribeNothing, () => true, () => false);

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

export default function RecipeSheet({ slug, onClose, onPlanned }: { slug: string; onClose: () => void; onPlanned?: () => void }) {
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
        <Card key={slug} slug={slug} onClose={onClose} titleId={titleId} onPlanned={onPlanned} />
      </div>
    </div>,
    document.body,
  );
}

function Card({ slug, onClose, titleId, onPlanned }: { slug: string; onClose: () => void; titleId: string; onPlanned?: () => void }) {
  const [recipe, setRecipe] = useState<RecipeDetail | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [people, setPeople] = useState<number | null>(null);
  const [multIndex, setMultIndex] = useState(MULTIPLIERS.indexOf(1));
  const [checked, setChecked] = useState<Set<number>>(() => new Set());
  const [doneSteps, setDoneSteps] = useState<Set<number>>(() => new Set());
  const [photoFailed, setPhotoFailed] = useState(false);
  const { timers: allTimers, now } = useTimers();
  // this card's timers; others keep running in the tray
  const timers = allTimers.filter((t) => t.slug === slug);
  const start = (key: string, label: string, seconds: number) =>
    startTimer({ slug, recipe: recipe?.name ?? "Recipe", key: `${slug}:${key}`, label, seconds });
  const cancel = cancelTimer;
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
      {timers.some((t) => !t.done) && !wake.on && wake.supported && (
        <p className="rs-wake-note">Timers keep going if you close the card. Turn on Keep screen on so you can watch them here.</p>
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
                          <StepText text={it.text} num={it.num} prefix={`${slug}:`} timers={timers} now={now} onStart={start} />
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

        <PlanIt slug={recipe.slug} onPlanned={onPlanned} />

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
  prefix,
  timers,
  now,
  onStart,
}: {
  text: string;
  num: number;
  /** timers are app-wide, so their keys carry the recipe */
  prefix: string;
  timers: Timer[];
  now: number;
  onStart: (key: string, label: string, seconds: number) => void;
}) {
  const parts: ReactNode[] = [];
  let at = 0;
  findDurations(text).forEach((d, i) => {
    parts.push(text.slice(at, d.start));
    const key = `${num}:${i}`;
    const t = timers.find((x) => x.key === prefix + key);
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

/** Put this recipe on a night in the next two weeks, right from the card. */
function PlanIt({ slug, onPlanned }: { slug: string; onPlanned?: () => void }) {
  const [nights, setNights] = useState<Week["nights"] | null>(null);
  const [date, setDate] = useState("");
  const [state, setState] = useState<{ busy: boolean; note: string; ok: boolean }>({ busy: false, note: "", ok: false });

  async function load() {
    setState({ busy: true, note: "", ok: false });
    try {
      const first = await api<Week>("/api/week");
      const next = await api<Week>(`/api/week?start=${addDays(first.start, 7)}`);
      const today = new Date().toLocaleDateString("en-CA");
      const upcoming = [...first.nights, ...next.nights].filter((n) => n.date >= today);
      setNights(upcoming);
      // the first open cooking night is the likely pick
      setDate((upcoming.find((n) => n.cooking && !n.title) ?? upcoming[0])?.date ?? "");
      setState({ busy: false, note: "", ok: false });
    } catch (e) {
      setState({ busy: false, note: (e as Error).message, ok: false });
    }
  }

  async function plan() {
    const n = nights?.find((x) => x.date === date);
    if (!n) return;
    setState({ busy: true, note: "", ok: false });
    try {
      await api("/api/week", jsonInit("PATCH", { date, recipeSlug: slug }));
      setState({ busy: false, note: `It's on ${n.day} ${shortDay(date)}.${n.title ? ` That replaces ${n.title}.` : ""}`, ok: true });
      setNights(null);
      onPlanned?.();
    } catch (e) {
      setState({ busy: false, note: (e as Error).message, ok: false });
    }
  }

  return (
    <section className="rs-plan" aria-label="Put it on a night">
      {nights ? (
        <div className="rs-plan-row">
          <label className="sr-only" htmlFor={`plan-${slug}`}>Night</label>
          <select id={`plan-${slug}`} value={date} onChange={(e) => setDate(e.target.value)}>
            {nights.map((n) => (
              <option key={n.date} value={n.date}>
                {n.day} {shortDay(n.date)}{n.title ? `: ${n.title}` : n.cooking ? ", open" : ", no cooking"}
              </option>
            ))}
          </select>
          <button type="button" className="push" onClick={() => void plan()} disabled={state.busy || !date}>{state.busy ? "Putting it on…" : "Put it on"}</button>
        </div>
      ) : (
        <button type="button" className="push alt" onClick={() => void load()} disabled={state.busy}>{state.busy ? "Pulling the week…" : "Put it on a night"}</button>
      )}
      {state.note && <p className={state.ok ? "ok-line" : "error-line"} role={state.ok ? "status" : "alert"}>{state.note}</p>}
    </section>
  );
}

const shortDay = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
function addDays(date: string, n: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
