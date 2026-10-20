"use client";

import { useCallback, useEffect, useState } from "react";
import type { User } from "@/lib/db";
import type { Week } from "@/lib/week";
import ChatView from "./ChatView";
import { ChatIcon, FreshIcon, PeopleIcon, PowerIcon, TicketIcon } from "./icons";
import ProfilesView, { FavesCard, type ProfileEntry } from "./ProfilesView";
import { api } from "./util";
import WeekTicket from "./WeekTicket";

type Tab = "chat" | "week" | "profiles";

export default function Kitchen({ me }: { me: User }) {
  const [tab, setTab] = useState<Tab>("chat");
  const [week, setWeek] = useState<Week | null>(null);
  const [weekStart, setWeekStart] = useState<string | undefined>();
  const [profiles, setProfiles] = useState<ProfileEntry[]>([]);
  const [mealie, setMealie] = useState<{ connected: boolean; recipes?: number } | null>(null);
  const [sheet, setSheet] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const [chatKey, setChatKey] = useState(0);

  const loadWeek = useCallback(async (start?: string) => {
    setWeek(await api<Week>(`/api/week${start ? `?start=${start}` : ""}`));
  }, []);
  const loadProfiles = useCallback(async () => {
    setProfiles((await api<{ profiles: ProfileEntry[] }>("/api/profiles")).profiles);
  }, []);

  useEffect(() => {
    let live = true;
    api<Week>(`/api/week${weekStart ? `?start=${weekStart}` : ""}`)
      .then((w) => live && setWeek(w))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [weekStart]);
  useEffect(() => {
    api<{ profiles: ProfileEntry[] }>("/api/profiles").then((p) => setProfiles(p.profiles)).catch(() => {});
    api<{ mealie: { connected: boolean; recipes?: number } }>("/api/status").then((s) => setMealie(s.mealie)).catch(() => {});
  }, []);

  // Sal changed something during a turn: refresh what's on screen
  const onChanged = useCallback(
    (changed: string[]) => {
      if (changed.includes("week")) loadWeek(weekStart).catch(() => {});
      if (changed.includes("profiles")) loadProfiles().catch(() => {});
    },
    [loadWeek, loadProfiles, weekStart],
  );

  async function signOut() {
    await fetch("/api/logout", { method: "POST" });
    window.location.href = "/login";
  }

  async function newConversation() {
    await api("/api/chat/reset", { method: "POST" });
    setSheet(false);
    setChatKey((k) => k + 1);
    setTab("chat");
  }

  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSheet(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet]);

  const avatar = (
    <span className="avatar" style={{ background: me.color }}>{me.name.slice(0, 2).toUpperCase()}</span>
  );

  return (
    <div className={`app${keyboard ? " keyboard" : ""}`} data-tab={tab}>
      <aside className="side">
        <div className="brand"><img src="/icon.svg" alt="" /><b>Sal&apos;s<br />Kitchen</b></div>
        <div>
          <h2>Signed in</h2>
          <div className="me">{avatar}<span>{me.name}<small>{me.role === "kid" ? "Kid" : "Grown-up"}</small></span></div>
        </div>
        <nav className="nav" aria-label="Sections">
          <button aria-current={tab !== "profiles" ? "page" : undefined} onClick={() => setTab("chat")}>Talk to Sal</button>
          <button aria-current={tab === "profiles" ? "page" : undefined} onClick={() => setTab("profiles")}>Taste profiles</button>
        </nav>
        <div className="foot">
          <span>
            <span className={`dot${mealie && !mealie.connected ? " off" : ""}`} />
            {mealie == null ? "Checking Mealie" : mealie.connected ? `Mealie connected, ${mealie.recipes} recipes` : "Mealie isn't reachable"}
          </span>
          <button onClick={newConversation}>Start a new conversation</button>
          <button onClick={signOut}>Switch person</button>
        </div>
      </aside>

      <main className="pane main">
        <div className="pane-head">
          <img src="/icon.svg" alt="" />
          <div>
            <h1>Sal</h1>
            <p>
              <span className="long">Your personal chef. 40 years on the line, still can&apos;t whisper.</span>
              <span className="short">Online. Probably eating.</span>
            </p>
          </div>
          <div className="head-actions">
            {tab === "profiles" ? (
              <button className="ghost" onClick={() => setTab("chat")}>Back to chat</button>
            ) : (
              <button className="ghost" onClick={newConversation}>New conversation</button>
            )}
          </div>
          <button className="me-btn" aria-label={`Menu for ${me.name}`} aria-haspopup="dialog" onClick={() => setSheet(true)}>
            {avatar}
          </button>
        </div>

        {tab === "profiles" ? (
          <ProfilesView me={me} profiles={profiles} setProfiles={setProfiles} />
        ) : (
          <ChatView key={chatKey} me={me} onChanged={onChanged} onKeyboard={setKeyboard} />
        )}
      </main>

      <aside className="pane rail" aria-label="This week">
        <WeekTicket
          me={me}
          week={week}
          setWeek={setWeek}
          onPrev={() => week && setWeekStart(shift(week.start, -7))}
          onNext={() => week && setWeekStart(shift(week.start, 7))}
          onThisWeek={() => setWeekStart(undefined)}
        />
        <FavesCard profiles={profiles} />
      </aside>

      <nav className="tabs" aria-label="Sections">
        <button aria-current={tab === "chat" ? "page" : undefined} onClick={() => setTab("chat")}><ChatIcon />Chat</button>
        <button aria-current={tab === "week" ? "page" : undefined} onClick={() => setTab("week")}><TicketIcon />This week</button>
        <button aria-current={tab === "profiles" ? "page" : undefined} onClick={() => setTab("profiles")}><PeopleIcon />Profiles</button>
      </nav>

      <div className={`scrim${sheet ? " open" : ""}`} onClick={() => setSheet(false)} />
      <div className={`sheet${sheet ? " open" : ""}`} role="dialog" aria-modal="true" aria-label="Menu" hidden={!sheet}>
        <div className="grab" />
        <div className="who">{avatar}<span><b>{me.name}</b><small>{mealie?.connected ? `Mealie connected, ${mealie.recipes} recipes` : "Mealie isn't reachable"}</small></span></div>
        <button className="item" onClick={newConversation}><FreshIcon />Start a new conversation</button>
        <button className="item" onClick={signOut}><PowerIcon />Switch person</button>
      </div>
    </div>
  );
}

function shift(date: string, days: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
