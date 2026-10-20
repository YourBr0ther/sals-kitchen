"use client";

import { useState } from "react";
import type { Profile, ProfileList, User } from "@/lib/db";
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

export default function ProfilesView({
  me,
  profiles,
  setProfiles,
}: {
  me: User;
  profiles: ProfileEntry[];
  setProfiles: (p: ProfileEntry[]) => void;
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
