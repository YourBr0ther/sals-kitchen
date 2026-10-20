"use client";

import { useState } from "react";

type Row = { name: string; role: "adult" | "kid"; pin: string };

export default function SetupScreen({ token }: { token: string }) {
  const [rows, setRows] = useState<Row[]>([
    { name: "", role: "adult", pin: "" },
    { name: "", role: "adult", pin: "" },
    { name: "", role: "kid", pin: "" },
  ]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const set = (i: number, patch: Partial<Row>) => setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ members: rows, token }),
    });
    if (res.ok) window.location.href = "/login";
    else {
      setError((await res.json()).error ?? "That didn't work.");
      setBusy(false);
    }
  }

  return (
    <main className="gate">
      <form className="gate-card" onSubmit={save}>
        <img src="/icon.svg" alt="" />
        <h1>Who eats here?</h1>
        <p>Add everyone Sal cooks for. Grown-ups get a 4-digit PIN to sign in. Kids get a taste profile the grown-ups look after.</p>
        {rows.map((r, i) => (
          <div className="setup-row" key={i}>
            <input aria-label="Name" placeholder="Name" value={r.name} onChange={(e) => set(i, { name: e.target.value })} />
            <select aria-label="Role" value={r.role} onChange={(e) => set(i, { role: e.target.value as Row["role"], pin: "" })}>
              <option value="adult">Grown-up</option>
              <option value="kid">Kid</option>
            </select>
            {r.role === "adult" ? (
              <input
                aria-label="PIN"
                placeholder="PIN"
                inputMode="numeric"
                pattern="\d{4}"
                maxLength={4}
                value={r.pin}
                onChange={(e) => set(i, { pin: e.target.value.replace(/\D/g, "") })}
              />
            ) : <span />}
            <button type="button" aria-label="Remove" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}
        <button type="button" className="link" onClick={() => setRows((r) => [...r, { name: "", role: "adult", pin: "" }])}>
          Add someone
        </button>
        <p className="err" role="alert">{error}</p>
        <button className="push" style={{ width: "100%" }} disabled={busy}>Set up the kitchen</button>
      </form>
    </main>
  );
}
