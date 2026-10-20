"use client";

import { useCallback, useEffect, useState } from "react";
import type { Settings } from "@/lib/settings";
import { api, jsonInit } from "./util";
import "@/app/settings.css";

type Reminders = Settings["reminders"];

/** What this phone can do about reminders right now. */
type Device = "checking" | "unsupported" | "ios-browser" | "server-off" | "denied" | "off" | "on";

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

/** The VAPID key arrives base64url; the browser wants raw bytes. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** The service worker registers after page load, and only in production builds. */
async function registration(): Promise<ServiceWorkerRegistration> {
  const reg = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
  ]);
  if (!reg) throw new Error("The app is still getting set up on this phone. Reload and try again.");
  return reg;
}

const TOGGLES: { key: "dinner" | "prep" | "sunday"; label: string; hint: string }[] = [
  { key: "dinner", label: "Tonight's dinner", hint: "A heads-up on cooking nights with a meal planned." },
  { key: "prep", label: "Prep the night before", hint: "At 8pm, when tomorrow's recipe needs thawing, marinating, or soaking." },
  { key: "sunday", label: "Sunday planning", hint: "At 10am, if next week's ticket is mostly empty." },
];

export default function RemindersSettings() {
  const [device, setDevice] = useState<Device>("checking");
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [reminders, setReminders] = useState<Reminders | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      const [settings, push] = await Promise.all([
        api<Settings>("/api/settings"),
        api<{ configured: boolean; publicKey: string | null }>("/api/push"),
      ]);
      setReminders(settings.reminders);
      setPublicKey(push.publicKey);
      if (!pushSupported()) return setDevice(isIos() && !isStandalone() ? "ios-browser" : "unsupported");
      if (isIos() && !isStandalone()) return setDevice("ios-browser");
      if (!push.configured) return setDevice("server-off");
      if (Notification.permission === "denied") return setDevice("denied");
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub && Notification.permission === "granted") {
        // tell the server again: it may have dropped this phone, or someone else signed in on it
        await api("/api/push", jsonInit("POST", sub.toJSON()));
        setDevice("on");
      } else {
        setDevice("off");
      }
    } catch (e) {
      setError((e as Error).message);
      setDevice((d) => (d === "checking" ? "off" : d));
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  async function turnOn() {
    if (!publicKey) return;
    setBusy(true);
    setError("");
    setNote("");
    try {
      const permission = await Notification.requestPermission();
      if (permission === "denied") return setDevice("denied");
      if (permission !== "granted") throw new Error("Sal needs permission to send reminders. Tap the button again and choose Allow.");
      const reg = await registration();
      const options = { userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) };
      let sub: PushSubscription;
      try {
        sub = await reg.pushManager.subscribe(options);
      } catch (e) {
        // an old sign-up made with a different server key blocks a new one
        const old = await reg.pushManager.getSubscription();
        if (!old) throw e;
        await old.unsubscribe();
        sub = await reg.pushManager.subscribe(options);
      }
      await api("/api/push", jsonInit("POST", sub.toJSON()));
      setDevice("on");
    } catch (e) {
      setError(e instanceof DOMException ? "This phone wouldn't sign up for reminders. Try again in a moment." : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    setError("");
    setNote("");
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await api("/api/push", jsonInit("DELETE", { endpoint: sub.endpoint }));
        // the server has stopped sending either way; the phone forgetting its sign-up is tidying up
        await sub.unsubscribe().catch((e) => console.warn("[push] unsubscribe failed:", e));
      }
      setDevice("off");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await api("/api/push/test", { method: "POST" });
      setNote("Sent. It should show up in a few seconds.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save(change: Partial<Reminders>) {
    if (!reminders) return;
    const before = reminders;
    setReminders({ ...reminders, ...change });
    setError("");
    try {
      setReminders((await api<Settings>("/api/settings", jsonInit("PATCH", { reminders: change }))).reminders);
    } catch (e) {
      setReminders(before);
      setError((e as Error).message);
    }
  }

  return (
    <section className="reminders" aria-labelledby="reminders-title">
      <h2 id="reminders-title">Reminders</h2>

      <div className="reminders-device">
        {device === "checking" && <p className="reminders-status">Checking this phone…</p>}
        {device === "unsupported" && <p className="reminders-status">This browser can&apos;t get reminders. Try Chrome, Edge, Firefox, or Safari on a recent phone.</p>}
        {device === "ios-browser" && (
          <p className="reminders-status">On iPhone, add Sal to your home screen first, then turn reminders on there.</p>
        )}
        {device === "server-off" && <p className="reminders-status">Reminders aren&apos;t set up on the server yet.</p>}
        {device === "denied" && (
          <p className="reminders-status">
            Notifications are blocked for Sal on this phone. Allow them in your phone or browser settings for this app, then come back and
            reload.
          </p>
        )}
        {device === "off" && (
          <>
            <p className="reminders-status">This phone doesn&apos;t get reminders.</p>
            <button type="button" className="reminders-primary" onClick={turnOn} disabled={busy || !publicKey}>
              Turn on reminders on this phone
            </button>
          </>
        )}
        {device === "on" && (
          <>
            <p className="reminders-status on">This phone gets reminders.</p>
            <div className="reminders-actions">
              <button type="button" className="reminders-secondary" onClick={sendTest} disabled={busy}>
                Send a test
              </button>
              <button type="button" className="reminders-secondary" onClick={turnOff} disabled={busy}>
                Turn off on this phone
              </button>
            </div>
          </>
        )}
        {note && (
          <p className="reminders-note" role="status">
            {note}
          </p>
        )}
        {error && (
          <p className="reminders-error" role="alert">
            {error}{" "}
            {(!reminders || !publicKey) && (
              <button type="button" className="ghost" onClick={() => void load()}>Try again</button>
            )}
          </p>
        )}
      </div>

      {reminders && (
        <ul className="reminders-list">
          {TOGGLES.map((t) => (
            <li key={t.key}>
              <label className="reminders-toggle">
                <span>
                  <b>{t.label}</b>
                  <small>{t.hint}</small>
                </span>
                <input type="checkbox" role="switch" checked={reminders[t.key]} onChange={(e) => void save({ [t.key]: e.target.checked })} />
              </label>
              {t.key === "dinner" && reminders.dinner && (
                <label className="reminders-time">
                  <span>Send it at</span>
                  <input
                    type="time"
                    step={60}
                    value={reminders.dinnerTime}
                    onChange={(e) => e.target.value && void save({ dinnerTime: e.target.value })}
                  />
                </label>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
