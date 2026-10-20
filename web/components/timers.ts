"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * Cooking timers for the whole app, not one recipe card: closing the card, switching tabs,
 * or reloading keeps them running. They're saved on this phone only.
 */
export type Timer = {
  id: string;
  /** which recipe card it came from, so the tray can reopen it */
  slug: string;
  recipe: string;
  /** the step and time it was started from, so the same chip can't start it twice */
  key: string;
  label: string;
  endsAt: number;
  done: boolean;
};

const STORE_KEY = "sal-timers";
// a finished timer nobody dismissed goes away on its own after this long
const KEEP_DONE_MS = 30 * 60_000;

let timers: Timer[] = [];
const listeners = new Set<() => void>();
const handles = new Map<string, ReturnType<typeof setTimeout>>();
let audio: AudioContext | null = null;
let started = false;

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(timers));
  } catch {
    // private mode: timers last until the page closes
  }
}

function emit() {
  save();
  listeners.forEach((l) => l());
}

/** Three short beeps. The context was unlocked by the tap that started a timer. */
function beep() {
  if (!audio) return;
  void audio.resume().catch(() => {});
  const t = audio.currentTime + 0.05;
  for (let i = 0; i < 3; i++) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = 880;
    const at = t + i * 0.32;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.35, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
    osc.connect(gain).connect(audio.destination);
    osc.start(at);
    osc.stop(at + 0.25);
  }
}

function finish(id: string, ring = true) {
  handles.delete(id);
  const t = timers.find((x) => x.id === id);
  if (!t || t.done) return;
  timers = timers.map((x) => (x.id === id ? { ...x, done: true } : x));
  emit();
  if (ring) {
    navigator.vibrate?.([300, 150, 300, 150, 300]);
    beep();
  }
}

function schedule(t: Timer) {
  clearTimeout(handles.get(t.id));
  handles.set(t.id, setTimeout(() => finish(t.id), Math.max(0, t.endsAt - Date.now())));
}

/** A locked or backgrounded phone holds timeouts back; on return, ring anything already up. */
function catchUp() {
  for (const t of timers) if (!t.done && t.endsAt <= Date.now()) finish(t.id);
}

function boot() {
  if (started || typeof window === "undefined") return;
  started = true;
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]") as Timer[];
    timers = Array.isArray(saved) ? saved.filter((t) => t && typeof t.endsAt === "number" && Date.now() - t.endsAt < KEEP_DONE_MS) : [];
  } catch {
    timers = [];
  }
  // ones that ran out while the app was closed show as done, without a surprise beep
  timers = timers.map((t) => (!t.done && t.endsAt <= Date.now() ? { ...t, done: true } : t));
  timers.filter((t) => !t.done).forEach(schedule);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && catchUp());
  // iPhones suspend sound when the app goes to the background; any tap wakes it back up for the next beep
  document.addEventListener("pointerdown", () => void audio?.resume().catch(() => {}), { passive: true });
  // another tab changed the timers: follow it instead of overwriting it
  window.addEventListener("storage", (e) => {
    if (e.key !== STORE_KEY) return;
    try {
      const next = JSON.parse(e.newValue ?? "[]") as Timer[];
      handles.forEach(clearTimeout);
      handles.clear();
      timers = Array.isArray(next) ? next : [];
      timers.filter((t) => !t.done).forEach(schedule);
      listeners.forEach((l) => l());
    } catch {
      // ignore a garbled copy
    }
  });
}

export function startTimer(t: { slug: string; recipe: string; key: string; label: string; seconds: number }) {
  boot();
  if (timers.some((x) => x.key === t.key && !x.done)) return;
  // iOS only plays sound from a context first started during a tap, so start it now
  if (!audio && typeof AudioContext !== "undefined") audio = new AudioContext();
  void audio?.resume().catch(() => {});
  const timer: Timer = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    slug: t.slug,
    recipe: t.recipe,
    key: t.key,
    label: t.label,
    endsAt: Date.now() + t.seconds * 1000,
    done: false,
  };
  timers = [...timers.filter((x) => x.key !== t.key), timer];
  schedule(timer);
  emit();
}

export function cancelTimer(id: string) {
  clearTimeout(handles.get(id));
  handles.delete(id);
  timers = timers.filter((t) => t.id !== id);
  emit();
}

const subscribe = (cb: () => void) => {
  boot();
  listeners.add(cb);
  return () => void listeners.delete(cb);
};
const EMPTY: Timer[] = [];

/** Every timer, plus a clock that ticks while any is running. */
export function useTimers(): { timers: Timer[]; now: number } {
  const all = useSyncExternalStore(subscribe, () => timers, () => EMPTY);
  // starts at the real time, so a new timer never flashes a huge countdown
  const [now, setNow] = useState(() => Date.now());
  const running = all.some((t) => !t.done);
  useEffect(() => {
    if (!running) return;
    const first = setTimeout(() => setNow(Date.now()), 0);
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => {
      clearTimeout(first);
      clearInterval(tick);
    };
  }, [running]);
  return { timers: all, now };
}

const pad = (n: number) => String(n).padStart(2, "0");
export function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}
