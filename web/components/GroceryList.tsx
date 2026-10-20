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

/**
 * Send check-offs left on this phone (from the offline page, or a list closed before it synced).
 * Called when the app opens or comes back online, so they reach Mealie without opening the list.
 */
export async function sendSavedChecks(start: string) {
  if (!navigator.onLine) return;
  for (;;) {
    const saved = readSaved(start);
    const next = saved && Object.entries(saved.pending)[0];
    if (!saved || !next) return;
    const [itemId, checked] = next;
    try {
      const res = await fetch("/api/week/groceries", jsonInit("PATCH", { start, itemId, checked }));
      if (!res.ok && res.status !== 404) return;
    } catch {
      return;
    }
    const now = readSaved(start) ?? saved;
    if (now.pending[itemId] === checked) delete now.pending[itemId];
    now.list.items = now.list.items.map((i) => (i.id === itemId ? { ...i, checked } : i));
    writeSaved(start, now);
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
  // the queue of check-offs not yet in Mealie; the ref is the truth, state only mirrors it for drawing
  const pendingRef = useRef<Record<string, boolean>>({});
  const listRef = useRef<List | null>(null);
  const [syncError, setSyncError] = useState("");

  const remember = useCallback(
    (l: List, p: Record<string, boolean>) => {
      listRef.current = l;
      pendingRef.current = p;
      setList(l);
      setPending(p);
      writeSaved(start, { list: l, at: Date.now(), pending: p });
    },
    [start],
  );

  /**
   * Send queued check-offs, one at a time, until the queue is empty. Taps made while it runs
   * join the same queue and get sent by this same loop. A failure stops it until the next try.
   */
  const flush = useCallback(async () => {
    if (flushing.current || !navigator.onLine) return;
    flushing.current = true;
    try {
      for (;;) {
        const next = Object.entries(pendingRef.current)[0];
        if (!next) break;
        const [itemId, checked] = next;
        const res = await fetch("/api/week/groceries", jsonInit("PATCH", { start, itemId, checked }));
        if (res.status === 401) return window.location.assign("/login");
        const r = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok && res.status !== 404) {
          setSyncError(r.error ?? "Couldn't reach Mealie to check that off. It'll try again.");
          break;
        }
        setSyncError("");
        // a second tap on the same item while this was sending wins; leave it queued
        const now = { ...pendingRef.current };
        if (now[itemId] === checked) delete now[itemId];
        const l = listRef.current;
        const items = l && res.ok ? l.items.map((i) => (i.id === itemId ? { ...i, checked } : i)) : (l?.items ?? []);
        // a 404 means it's gone from Mealie; drop it from the list too
        const kept = res.status === 404 ? items.filter((i) => i.id !== itemId) : items;
        if (l) remember({ ...l, items: kept }, now);
        else {
          pendingRef.current = now;
          setPending(now);
        }
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
      // queued taps that point at items Mealie no longer has can't be sent anywhere
      const ids = new Set(r.list.items.map((i) => i.id));
      remember(r.list, Object.fromEntries(Object.entries(pendingRef.current).filter(([id]) => ids.has(id))));
      void flush();
    } catch (e) {
      const saved = readSaved(start);
      if (saved) {
        // show the copy on this phone and say how old it is
        listRef.current = saved.list;
        pendingRef.current = saved.pending;
        setList(saved.list);
        setPending(saved.pending);
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
        listRef.current = saved.list;
        pendingRef.current = saved.pending;
        setList(saved.list);
        setPending(saved.pending);
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
    const l = listRef.current;
    if (!l) return;
    const current = pendingRef.current[item.id] ?? l.items.find((i) => i.id === item.id)?.checked ?? item.checked;
    // shows right away; offline, it waits on this phone until the connection is back
    remember(l, { ...pendingRef.current, [item.id]: !current });
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
        {(error || syncError || savedAt || waiting > 0) && (
          <p className="gl-status" role="status">
            {error || syncError}
            {savedAt && ` Showing the copy on this phone from ${new Date(savedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`}
            {waiting > 0 && !navigator.onLine && ` ${waiting} check-off${waiting === 1 ? "" : "s"} will sync when you're back online.`}
            {(error || syncError) && navigator.onLine && (
              <button type="button" className="ghost" onClick={() => void (syncError ? flush() : load())}>Try again</button>
            )}
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
