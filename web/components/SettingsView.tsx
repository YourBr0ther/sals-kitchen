"use client";

import { useCallback, useEffect, useState } from "react";
import type { User } from "@/lib/db";
import type { Settings } from "@/lib/settings";
import RemindersSettings from "./RemindersSettings";
import { api, initials, jsonInit } from "./util";

export type Theme = "system" | "light" | "dark";
export const THEME_KEY = "sal-theme";

export function applyTheme(t: Theme) {
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try {
    if (t === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, t);
  } catch {
    // private mode: the choice lasts until the page closes
  }
}

function readTheme(): Theme {
  const t = typeof document !== "undefined" ? document.documentElement.dataset.theme : undefined;
  return t === "light" || t === "dark" ? t : "system";
}

function Choice<T extends string>({ name, value, options, onChange }: { name: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="radiogroup" aria-label={name}>
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={value === o.value} className={value === o.value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function PinForm() {
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const digits = (v: string) => v.replace(/\D/g, "").slice(0, 4);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (next.length !== 4) return setMsg({ ok: false, text: "The new PIN needs 4 digits." });
    if (next !== again) return setMsg({ ok: false, text: "The two new PINs don't match." });
    setSaving(true);
    try {
      await api("/api/household", jsonInit("PATCH", { currentPin: cur, newPin: next }));
      setMsg({ ok: true, text: "PIN changed. Use the new one next time you log in." });
      setCur("");
      setNext("");
      setAgain("");
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }

  const field = (label: string, v: string, set: (s: string) => void, auto: string) => (
    <label className="field">
      <span>{label}</span>
      <input type="password" inputMode="numeric" autoComplete={auto} pattern="\d{4}" maxLength={4} value={v} onChange={(e) => set(digits(e.target.value))} />
    </label>
  );

  return (
    <form className="pin-form" onSubmit={(e) => void save(e)}>
      {field("Current PIN", cur, setCur, "current-password")}
      {field("New PIN", next, setNext, "new-password")}
      {field("New PIN again", again, setAgain, "new-password")}
      <button className="push" disabled={saving || cur.length !== 4 || next.length !== 4 || again.length !== 4}>{saving ? "Saving…" : "Change PIN"}</button>
      {msg && <p className={msg.ok ? "ok-line" : "error-line"} role={msg.ok ? "status" : "alert"}>{msg.text}</p>}
    </form>
  );
}

function Household({ me }: { me: User }) {
  const [members, setMembers] = useState<User[] | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState<"adult" | "kid">("kid");
  const [pin, setPin] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setMembers((await api<{ members: User[] }>("/api/household")).members);
      setLoadError("");
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      setMembers((await api<{ members: User[] }>("/api/household", jsonInit("POST", { name, role, pin }))).members);
      setMsg({ ok: true, text: `${name.trim()} is in. Sal will start learning what they like.` });
      setName("");
      setPin("");
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {loadError && (
        <p className="error-line" role="alert">
          {loadError} <button className="ghost" onClick={() => void load()}>Try again</button>
        </p>
      )}
      <ul className="members">
        {members?.map((m) => (
          <li key={m.id}>
            <span className="avatar" style={{ background: m.color }}>{initials(m.name)}</span>
            <span>{m.name}{m.id === me.id ? " (you)" : ""}<small>{m.role === "kid" ? "Kid, no login" : "Grown-up"}</small></span>
          </li>
        ))}
      </ul>
      {me.role === "adult" && (
        <form className="add-member" onSubmit={(e) => void add(e)}>
          <label className="field">
            <span>Name</span>
            <input value={name} maxLength={30} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </label>
          <Choice name="Grown-up or kid" value={role} onChange={setRole} options={[{ value: "kid", label: "Kid" }, { value: "adult", label: "Grown-up" }]} />
          {role === "adult" && (
            <label className="field">
              <span>Their 4-digit PIN</span>
              <input type="password" inputMode="numeric" autoComplete="new-password" maxLength={4} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))} />
            </label>
          )}
          <button className="push" disabled={saving || !name.trim() || (role === "adult" && pin.length !== 4)}>{saving ? "Adding…" : "Add to the household"}</button>
        </form>
      )}
      {msg && <p className={msg.ok ? "ok-line" : "error-line"} role={msg.ok ? "status" : "alert"}>{msg.text}</p>}
    </>
  );
}

export default function SettingsView({
  me,
  settings,
  loadError,
  onRetry,
  onSettings,
}: {
  me: User;
  settings: Settings | null;
  loadError: string;
  onRetry: () => void;
  onSettings: (change: Partial<Settings>) => void;
}) {
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => {
    const t = setTimeout(() => setTheme(readTheme()), 0);
    return () => clearTimeout(t);
  }, []);

  return (
    <section className="profiles settings" aria-label="Settings">
      <h2>Settings</h2>
      <p className="sub">These are yours, {me.name}. Everyone in the household sets their own.</p>

      <div className="set-group">
        <RemindersSettings />
      </div>

      <div className="set-group">
        <h3>Sal&apos;s voice</h3>
        <p className="none">Tap the speaker next to any reply to hear it. Sal can also read replies out on his own.</p>
        {!settings && loadError ? (
          <p className="error-line" role="alert">
            Couldn&apos;t load your settings. {loadError} <button className="ghost" onClick={onRetry}>Try again</button>
          </p>
        ) : !settings ? (
          <p className="none">Loading…</p>
        ) : (
        <Choice
          name="Read replies out loud"
          value={settings?.readAloud ?? "voice"}
          onChange={(readAloud) => onSettings({ readAloud })}
          options={[
            { value: "off", label: "Only when I tap" },
            { value: "voice", label: "After my voice notes" },
            { value: "always", label: "Always" },
          ]}
        />
        )}
      </div>

      <div className="set-group">
        <h3>Look</h3>
        <Choice
          name="Theme"
          value={theme}
          onChange={(t) => {
            setTheme(t);
            applyTheme(t);
          }}
          options={[
            { value: "system", label: "Match my phone" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
        />
      </div>

      {me.hasPin && (
        <div className="set-group">
          <h3>Your PIN</h3>
          <PinForm />
        </div>
      )}

      <div className="set-group">
        <h3>Household</h3>
        <Household me={me} />
      </div>
    </section>
  );
}
