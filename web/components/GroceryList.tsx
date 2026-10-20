"use client";

import "@/app/groceries.css";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { XIcon } from "./icons";
import { jsonInit } from "./util";

type Item = { id: string; text: string; checked: boolean; aisle: string };
type List = { name: string; url: string; items: Item[] };
type Saved = { list: List; at: number; pending: Record<string, boolean> };

const subscribeNothing = () => () => {};
const useOnClient = () => useSyncExternalStore(subscribeNothing, () => true, () => false);

// the last copy of each week's list stays on the phone, so it still opens in a store with no signal
const key = (start: string) => `sal-groceries-${start}`;
function readSaved(start: string): Saved | null {
  try {
    return JSON.parse(localStorage.getItem(key(start)) ?? "null") as Saved | null;
  } catch {
    return null;
  }
}
function writeSaved(start: string, s: Saved) {
  try {
    localStorage.setItem(key(start), JSON.stringify(s));
  } catch {
    // no room or private mode: it just won't open offline
  }
}

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);

/** The week's grocery list as a checklist for the store. Checking things off writes to Mealie. */
export default function GroceryList({ start, onClose }: { start: string; onClose: () => void }) {
  const onClient = useOnClient();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const [list, setList] = useState<List | null>(null);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [missing, setMissing] = useState(false);
  const [showChecked, setShowChecked] = useState(false);
  const flushing = useRef(false);
  const pendingRef = useRef(pending);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  const remember = useCallback(
    (l: List, p: Record<string, boolean>) => {
      setList(l);
      setPending(p);
      writeSaved(start, { list: l, at: Date.now(), pending: p });
    },
    [start],
  );

  /** Send checks made offline, oldest first. Stops at the first failure and tries again later. */
  const flush = useCallback(async () => {
    if (flushing.current || !navigator.onLine) return;
    flushing.current = true;
    try {
      for (const [itemId, checked] of Object.entries(pendingRef.current)) {
        const res = await fetch("/api/week/groceries", jsonInit("PATCH", { start, itemId, checked }));
        const r = (await res.json().catch(() => ({}))) as { list?: List; error?: string };
        if (!res.ok && res.status !== 404) break;
        const { [itemId]: _sent, ...rest } = pendingRef.current;
        void _sent;
        pendingRef.current = rest;
        if (r.list) remember(r.list, rest);
        else setPending(rest);
      }
    } catch {
      // still no connection; the next 'online' tries again
    } finally {
      flushing.current = false;
    }
  }, [start, remember]);

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await fetch(`/api/week/groceries?start=${start}`, { cache: "no-store" });
      if (res.status === 401) return window.location.assign("/login");
      const r = (await res.json().catch(() => ({}))) as { list?: List | null; error?: string };
      if (!res.ok) throw new Error(r.error ?? "Couldn't load the grocery list. Try again.");
      if (!r.list) {
        setMissing(true);
        return;
      }
      setSavedAt(null);
      remember(r.list, pendingRef.current);
      void flush();
    } catch (e) {
      const saved = readSaved(start);
      if (saved) {
        // show the copy on this phone and say how old it is
        setList(saved.list);
        setPending(saved.pending);
        pendingRef.current = saved.pending;
        setSavedAt(saved.at);
      }
      setError(navigator.onLine ? (e as Error).message : "You're offline.");
    }
  }, [start, remember, flush]);

  useEffect(() => {
    if (!onClient) return;
    const saved = readSaved(start);
    const t = setTimeout(() => {
      if (saved) {
        setList(saved.list);
        setPending(saved.pending);
        pendingRef.current = saved.pending;
      }
      void load();
    }, 0);
    const onOnline = () => void load();
    window.addEventListener("online", onOnline);
    return () => {
      clearTimeout(t);
      window.removeEventListener("online", onOnline);
    };
  }, [onClient, start, load]);

  // focus and Escape, like the recipe card
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (!onClient) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      opener?.focus();
    };
  }, [onClient]);

  function toggle(item: Item) {
    if (!list) return;
    const checked = !(pending[item.id] ?? item.checked);
    // shows right away; offline, it waits on this phone until the connection is back
    const next = { ...pending, [item.id]: checked };
    pendingRef.current = next;
    remember(list, next);
    void flush();
  }

  if (!onClient) return null;

  const isChecked = (i: Item) => pending[i.id] ?? i.checked;
  const items = list?.items ?? [];
  const left = items.filter((i) => !isChecked(i));
  const done = items.filter(isChecked);
  const aisles = [...new Set(left.map((i) => i.aisle))];
  const waiting = Object.keys(pending).length;

  return createPortal(
    <div className="gl-root">
      <div className="gl-scrim" onClick={onClose} aria-hidden="true" />
      <div className="gl" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={panel} tabIndex={-1}>
        <div className="gl-bar">
          <h2 id={titleId}>Grocery list</h2>
          <button type="button" className="gl-close" onClick={onClose} aria-label="Close grocery list"><XIcon /></button>
        </div>
        {(error || savedAt || waiting > 0) && (
          <p className="gl-status" role="status">
            {error}
            {savedAt && ` Showing the copy on this phone from ${new Date(savedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`}
            {waiting > 0 && ` ${waiting} check-off${waiting === 1 ? "" : "s"} will sync when you're back online.`}
            {error && navigator.onLine && <button type="button" className="ghost" onClick={() => void load()}>Try again</button>}
          </p>
        )}
        {missing && !list && <p className="gl-empty">There&apos;s no grocery list for this week yet. Make one from the week ticket.</p>}
        {!list && !missing && !error && <p className="gl-empty">Pulling the list…</p>}
        {list && (
          <div className="gl-body">
            <p className="gl-count">{left.length ? `${left.length} to get` : "All of it's in the cart."}</p>
            {aisles.map((a) => (
              <section key={a}>
                <h3>{a}</h3>
                <ul>
                  {left.filter((i) => i.aisle === a).map((i) => (
                    <li key={i.id}>
                      <button type="button" role="checkbox" aria-checked={false} className="gl-item" onClick={() => toggle(i)}>
                        <span className="gl-box" aria-hidden="true" />
                        <span>{i.text}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {done.length > 0 && (
              <section className="gl-done">
                <button type="button" className="ghost" onClick={() => setShowChecked((v) => !v)} aria-expanded={showChecked}>
                  {showChecked ? "Hide" : "Show"} what&apos;s in the cart ({done.length})
                </button>
                {showChecked && (
                  <ul>
                    {done.map((i) => (
                      <li key={i.id}>
                        <button type="button" role="checkbox" aria-checked className="gl-item on" onClick={() => toggle(i)}>
                          <span className="gl-box" aria-hidden="true"><CheckIcon /></span>
                          <span>{i.text}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
            <a className="gl-mealie" href={list.url} target="_blank" rel="noreferrer">Open it in Mealie</a>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
