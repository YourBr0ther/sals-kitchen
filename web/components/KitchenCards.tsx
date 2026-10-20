"use client";

import { useCallback, useEffect, useState } from "react";
import type { Activity } from "@/lib/activity";
import type { PantryItem } from "@/lib/pantry";
import { api, jsonInit, timeLabel } from "./util";

/** What's already in the kitchen. Shared, and left off the grocery list. */
export function PantryCard({ version }: { version: number }) {
  const [items, setItems] = useState<PantryItem[] | null>(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");

  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: PantryItem[] }>("/api/pantry")).items);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // `version` bumps when Sal changes the list during a chat
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load, version]);

  async function change(body: { add?: string[]; remove?: string[] }) {
    try {
      setError("");
      setItems((await api<{ items: PantryItem[] }>("/api/pantry", jsonInit("PATCH", body))).items);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section className="card pantry" aria-label="In the kitchen">
      <h3>In the kitchen</h3>
      <p className="card-sub">Left off the grocery list. Tell Sal, or send him a photo of the fridge.</p>
      {error && <p className="error-line" role="alert">{error}</p>}
      <div className="plist">
        {items?.map((i) => (
          <span key={i.id} className="pill editable">
            {i.item}
            <button aria-label={`Used up ${i.item}`} onClick={() => void change({ remove: [i.item] })}>×</button>
          </span>
        ))}
        {items && !items.length && <span className="none">Nothing listed yet</span>}
      </div>
      <form
        className="addform"
        onSubmit={(e) => {
          e.preventDefault();
          const add = draft.split(",").map((s) => s.trim()).filter(Boolean);
          if (add.length) void change({ add });
          setDraft("");
        }}
      >
        <input aria-label="Add something you have" placeholder="Add something you have" value={draft} onChange={(e) => setDraft(e.target.value)} enterKeyHint="done" />
      </form>
    </section>
  );
}

/** The household log: who planned, saved, shopped, and how dinners went. */
export function ActivityCard({ version }: { version: number }) {
  const [items, setItems] = useState<Activity[] | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      api<{ activity: Activity[] }>("/api/activity")
        .then((r) => setItems(r.activity))
        .catch(() => setItems((cur) => cur ?? []));
    }, 0);
    return () => clearTimeout(t);
  }, [version]);

  if (!items?.length) return null;
  return (
    <section className="card activity" aria-label="Kitchen log">
      <h3>Kitchen log</h3>
      <ul>
        {[...items].reverse().slice(0, 8).map((a) => (
          <li key={a.id}>
            <b>{a.name ?? "Someone"}</b> {a.text}
            <small>{timeLabel(a.createdAt)}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}
