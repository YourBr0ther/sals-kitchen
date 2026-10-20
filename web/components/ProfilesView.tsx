"use client";

import { useCallback, useEffect, useState } from "react";
import type { Profile, ProfileList, User } from "@/lib/db";
import type { Memory } from "@/lib/memory";
import { api, initials, jsonInit } from "./util";

export type ProfileEntry = { user: User; profile: Profile; editable: boolean };

const SECTIONS: { list: ProfileList; label: string; placeholder: string }[] = [
  { list: "loves", label: "Loves", placeholder: "Add a favorite" },
  { list: "nopes", label: "Won't eat", placeholder: "Add a no" },
  { list: "allergies", label: "Allergies", placeholder: "Add an allergy" },
  { list: "notes", label: "Sal noticed", placeholder: "Add a note" },
];

function AddForm({ placeholder, onAdd }: { placeholder: string; onAdd: (v: string) => void }) {
  const [v, setV] = useState("");
  return (
    <form
      className="addform"
      onSubmit={(e) => {
        e.preventDefault();
        if (v.trim()) onAdd(v.trim());
        setV("");
      }}
    >
      <input aria-label={placeholder} placeholder={placeholder} value={v} onChange={(e) => setV(e.target.value)} enterKeyHint="done" />
    </form>
  );
}

/** What Sal privately remembers about the signed-in person. Only they see it. */
function MemoryBox() {
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setMemories((await api<{ memories: Memory[] }>("/api/memories")).memories);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    // Sal may have noted something new since this screen last loaded
    const onVisible = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  async function change(init: RequestInit, url = "/api/memories") {
    try {
      setError("");
      setMemories((await api<{ memories: Memory[] }>(url, init)).memories);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="memory-box">
      <h4>What Sal remembers about you</h4>
      <p className="none">Only you can see these. Sal adds to them as you chat; remove anything that&apos;s wrong.</p>
      {error && <p className="error-line" role="alert">{error}</p>}
      {memories === null && !error && <p className="none">Loading…</p>}
      {memories && !memories.length && <p className="none">Nothing yet. Tell Sal about your week, your schedule, or your kitchen.</p>}
      <ul className="memories">
        {memories?.map((m) => (
          <li key={m.id}>
            <span>{m.text}</span>
            <button aria-label={`Forget: ${m.text}`} onClick={() => void change({ method: "DELETE" }, `/api/memories?id=${m.id}`)}>×</button>
          </li>
        ))}
      </ul>
      <AddForm placeholder="Tell Sal something to remember" onAdd={(text) => void change(jsonInit("POST", { text }))} />
    </div>
  );
}

export default function ProfilesView({
  me,
  profiles,
  setProfiles,
  loadError,
  onRetry,
}: {
  me: User;
  profiles: ProfileEntry[];
  setProfiles: (p: ProfileEntry[]) => void;
  loadError: string;
  onRetry: () => void;
}) {
  const [error, setError] = useState("");

  async function change(userId: number, list: ProfileList, body: { add?: string; remove?: string }) {
    try {
      setError("");
      const r = await api<{ profiles: ProfileEntry[] }>("/api/profiles", jsonInit("PATCH", { userId, list, ...body }));
      setProfiles(r.profiles);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // me first, then everyone else
  const sorted = [...profiles].sort((a, b) => Number(b.user.id === me.id) - Number(a.user.id === me.id));

  return (
    <section className="profiles" aria-label="Taste profiles">
      <h2>Taste profiles</h2>
      <p className="sub">Sal fills these in as you chat. Everybody can see everybody&apos;s. You can edit your own, and grown-ups look after the kids&apos;.</p>
      {error && <p className="error-line" role="alert">{error}</p>}
      {loadError && !profiles.length && (
        <p className="error-line" role="alert">
          {loadError} <button className="ghost" onClick={onRetry}>Try again</button>
        </p>
      )}
      <div className="pgrid">
        {sorted.map(({ user, profile, editable }) => (
          <div className="pbox" key={user.id}>
            <h3>
              <span className="avatar" style={{ background: user.color }}>{initials(user.name)}</span>
              {user.name}{user.id === me.id ? " (you)" : ""}
            </h3>
            {SECTIONS.map(({ list, label, placeholder }) => {
              const items = profile[list];
              if (!items.length && !editable) return null;
              return (
                <div key={list}>
                  <h4>{label}</h4>
                  <div className="plist">
                    {items.map((t) => (
                      <span key={t} className={`pill ${list}${editable ? " editable" : ""}`}>
                        {t}
                        {editable && (
                          <button aria-label={`Remove ${t}`} onClick={() => change(user.id, list, { remove: t })}>×</button>
                        )}
                      </span>
                    ))}
                    {!items.length && <span className="none">Nothing yet</span>}
                  </div>
                  {editable && <AddForm placeholder={placeholder} onAdd={(v) => change(user.id, list, { add: v })} />}
                </div>
              );
            })}
            {!editable && SECTIONS.every(({ list }) => !profile[list].length) && (
              <p className="none">Sal doesn&apos;t know much about {user.name} yet.</p>
            )}
            {user.id === me.id && <MemoryBox />}
          </div>
        ))}
      </div>
    </section>
  );
}

export function FavesCard({ profiles }: { profiles: ProfileEntry[] }) {
  const withLoves = profiles.filter((p) => p.profile.loves.length);
  if (!withLoves.length) return null;
  return (
    <section className="card">
      <h3>Family favorites</h3>
      <div className="faves">
        {withLoves.map(({ user, profile }) => (
          <div className="fave-row" key={user.id}>
            <span className="avatar" style={{ background: user.color }}>{initials(user.name)}</span>
            <div><b>{user.name}</b><p>{profile.loves.slice(0, 5).join(", ")}</p></div>
          </div>
        ))}
      </div>
    </section>
  );
}
