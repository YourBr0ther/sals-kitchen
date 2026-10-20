"use client";

import { useEffect, useState } from "react";
import type { User } from "@/lib/db";
import { initials } from "./util";

const PIN_LENGTH = 4;

export default function LoginScreen({ people }: { people: User[] }) {
  const [who, setWho] = useState<User | null>(people.length === 1 ? people[0] : null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(value: string) {
    if (!who) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: who.id, pin: value }),
      });
      if (res.ok) {
        window.location.assign("/");
        return;
      }
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "That didn't work. Try again.");
    } catch {
      setError(navigator.onLine ? "Can't reach the kitchen. Try again." : "You're offline. Try again once you're connected.");
    }
    setPin("");
    setBusy(false);
  }

  function press(d: string) {
    if (busy) return;
    const next = (pin + d).slice(0, 8);
    setPin(next);
    if (next.length === PIN_LENGTH) submit(next);
  }

  // hardware keyboards work too
  useEffect(() => {
    if (!who) return;
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") setPin((p) => p.slice(0, -1));
      else if (e.key === "Escape") setWho(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <main className="gate">
      <div className="gate-card">
        <img src="/icon.svg" alt="" />
        <h1>Sal&apos;s Kitchen</h1>
        {!who ? (
          <>
            <p>Who&apos;s cooking?</p>
            <div className="people">
              {people.map((u) => (
                <button key={u.id} onClick={() => setWho(u)}>
                  <span className="avatar" style={{ background: u.color }}>{initials(u.name)}</span>
                  {u.name}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <p>Hey {who.name}. Enter your PIN.</p>
            <div className="pin-dots" aria-label={`${pin.length} of ${PIN_LENGTH} digits entered`}>
              {Array.from({ length: PIN_LENGTH }, (_, i) => (
                <i key={i} className={i < pin.length ? "on" : ""} />
              ))}
            </div>
            <p className="err" role="alert">{error}</p>
            <div className="keypad">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
                <button key={d} onClick={() => press(d)} disabled={busy}>{d}</button>
              ))}
              {people.length > 1 ? (
                <button className="muted" onClick={() => { setWho(null); setPin(""); setError(""); }}>Back</button>
              ) : <span />}
              <button onClick={() => press("0")} disabled={busy}>0</button>
              <button className="muted" onClick={() => setPin((p) => p.slice(0, -1))} aria-label="Delete">Delete</button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
