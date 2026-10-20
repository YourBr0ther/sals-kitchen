"use client";

import { useCallback, useEffect, useState } from "react";
import type { User } from "@/lib/db";
import type { Settings } from "@/lib/settings";
import type { Week } from "@/lib/week";
import ChatView from "./ChatView";
import { ChatIcon, ClockIcon, FreshIcon, GearIcon, PeopleIcon, PowerIcon, TicketIcon } from "./icons";
import { ActivityCard, PantryCard } from "./KitchenCards";
import PastConversations from "./PastConversations";
import ProfilesView, { FavesCard, type ProfileEntry } from "./ProfilesView";
import { useInstall, useOnline } from "./Pwa";
import RecipeSheet from "./RecipeSheet";
import SettingsView from "./SettingsView";
import { api, jsonInit } from "./util";
import WeekTicket from "./WeekTicket";

type Tab = "chat" | "week" | "profiles" | "settings" | "past";
const TABS: Tab[] = ["chat", "week", "profiles", "settings", "past"];


export default function Kitchen({ me }: { me: User }) {
  const [tab, setTab] = useState<Tab>("chat");
  const [week, setWeek] = useState<Week | null>(null);
  const [weekError, setWeekError] = useState("");
  const [weekStart, setWeekStart] = useState<string | undefined>();
  const [profiles, setProfiles] = useState<ProfileEntry[]>([]);
  const [profilesError, setProfilesError] = useState("");
  const [mealie, setMealie] = useState<{ connected: boolean; recipes?: number } | null>(null);
  const [sheet, setSheet] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const [chatKey, setChatKey] = useState(0);
  const [chatBusy, setChatBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [showIosHelp, setShowIosHelp] = useState(false);
  const [recipe, setRecipe] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  // bumped when something may have changed the kitchen list or the household log
  const [kitchenVersion, setKitchenVersion] = useState(0);
  const online = useOnline();
  const { state: installState, install } = useInstall();

  const loadWeek = useCallback(async (start?: string) => {
    try {
      setWeek(await api<Week>(`/api/week${start ? `?start=${start}` : ""}`));
      setWeekError("");
    } catch (e) {
      setWeekError((e as Error).message);
    }
  }, []);
  const loadProfiles = useCallback(async () => {
    try {
      setProfiles((await api<{ profiles: ProfileEntry[] }>("/api/profiles")).profiles);
      setProfilesError("");
    } catch (e) {
      setProfilesError((e as Error).message);
    }
  }, []);

  // home-screen shortcuts open /?tab=week; read it after hydration so server and client agree
  useEffect(() => {
    const t = setTimeout(() => {
      const fromUrl = new URLSearchParams(window.location.search).get("tab") as Tab | null;
      if (fromUrl && TABS.includes(fromUrl) && fromUrl !== "chat") setTab(fromUrl);
    }, 0);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void loadWeek(weekStart), 0);
    return () => clearTimeout(t);
  }, [loadWeek, weekStart]);
  useEffect(() => {
    const t = setTimeout(() => {
      void loadProfiles();
      api<Settings>("/api/settings")
        .then(setSettings)
        .catch(() => null);
      api<{ mealie: { connected: boolean; recipes?: number } }>("/api/status")
        .then((s) => setMealie(s.mealie))
        .catch(() => setMealie({ connected: false }));
    }, 0);
    return () => clearTimeout(t);
  }, [loadProfiles]);

  // back in the app after a while: the week may have changed on someone else's phone
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void loadWeek(weekStart);
        void loadProfiles();
        setKitchenVersion((v) => v + 1);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [loadWeek, loadProfiles, weekStart]);

  // Sal changed something during a turn: refresh what's on screen
  const onChanged = useCallback(
    (changed: string[]) => {
      if (changed.includes("week")) void loadWeek(weekStart);
      if (changed.includes("profiles")) void loadProfiles();
      setKitchenVersion((v) => v + 1);
    },
    [loadWeek, loadProfiles, weekStart],
  );

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  async function signOut() {
    await fetch("/api/logout", { method: "POST" }).catch(() => null);
    window.location.assign("/login");
  }

  async function newConversation() {
    if (chatBusy) {
      setNotice("Wait for Sal to finish answering, then start fresh.");
      return;
    }
    try {
      await api("/api/chat/reset", { method: "POST" });
      setSheet(false);
      setChatKey((k) => k + 1);
      setTab("chat");
    } catch (e) {
      setNotice((e as Error).message);
    }
  }

  async function changeSettings(change: Partial<Settings>) {
    // show it right away; the server's answer is the truth
    setSettings((cur) => (cur ? { ...cur, ...change } : cur));
    try {
      setSettings(await api<Settings>("/api/settings", jsonInit("PATCH", change)));
    } catch (e) {
      setNotice((e as Error).message);
    }
  }

  function switchTab(t: Tab) {
    setSheet(false);
    setTab(t);
    // keep the address in step so a reload (or a home-screen shortcut) lands on the same tab
    window.history.replaceState(null, "", t === "chat" ? "/" : `/?tab=${t}`);
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
  const mealieLine = mealie == null ? "Checking Mealie" : mealie.connected ? `Mealie connected, ${mealie.recipes} recipes` : "Mealie isn't reachable";

  return (
    <div className={`app${keyboard ? " keyboard" : ""}`} data-tab={tab}>
      <aside className="side">
        <div className="brand"><img src="/icon.svg" alt="" /><b>Sal&apos;s<br />Kitchen</b></div>
        <div>
          <h2>Signed in</h2>
          <div className="me">{avatar}<span>{me.name}<small>{me.role === "kid" ? "Kid" : "Grown-up"}</small></span></div>
        </div>
        <nav className="nav" aria-label="Sections">
          <button aria-current={tab === "chat" || tab === "week" ? "page" : undefined} onClick={() => switchTab("chat")}>Talk to Sal</button>
          <button aria-current={tab === "past" ? "page" : undefined} onClick={() => switchTab("past")}>Earlier conversations</button>
          <button aria-current={tab === "profiles" ? "page" : undefined} onClick={() => switchTab("profiles")}>Taste profiles</button>
          <button aria-current={tab === "settings" ? "page" : undefined} onClick={() => switchTab("settings")}>Settings</button>
        </nav>
        <div className="foot">
          <span><span className={`dot${mealie && !mealie.connected ? " off" : ""}`} />{mealieLine}</span>
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
              <span className="short">{online ? "Online. Probably eating." : "You're offline"}</span>
            </p>
          </div>
          <div className="head-actions">
            {tab === "profiles" || tab === "settings" || tab === "past" ? (
              <button className="ghost" onClick={() => switchTab("chat")}>Back to chat</button>
            ) : (
              <button className="ghost" onClick={newConversation} disabled={chatBusy}>New conversation</button>
            )}
          </div>
          <button className="me-btn" aria-label={`Menu for ${me.name}`} aria-haspopup="dialog" onClick={() => setSheet(true)}>
            {avatar}
          </button>
        </div>

        {!online && <div className="banner" role="status">You&apos;re offline. Sal will be back when your connection is.</div>}
        {notice && <div className="banner" role="status">{notice}</div>}

        {/* both stay mounted so switching tabs never cuts off a reply that's streaming in */}
        <div className="view" hidden={tab !== "chat" && tab !== "week"}>
          <ChatView
            key={chatKey}
            me={me}
            onChanged={onChanged}
            onKeyboard={setKeyboard}
            onBusy={setChatBusy}
            onOpenRecipe={setRecipe}
            onShowPast={() => switchTab("past")}
            readAloud={settings?.readAloud ?? "voice"}
          />
        </div>
        <div className="view" hidden={tab !== "profiles"}>
          <ProfilesView me={me} profiles={profiles} setProfiles={setProfiles} loadError={profilesError} onRetry={loadProfiles} />
        </div>
        {tab === "settings" && (
          <div className="view">
            <SettingsView me={me} settings={settings} onSettings={(c) => void changeSettings(c)} />
          </div>
        )}
        {tab === "past" && (
          <div className="view">
            <PastConversations key={chatKey} me={me} onClose={() => switchTab("chat")} onOpenRecipe={setRecipe} />
          </div>
        )}
      </main>

      <aside className="pane rail" aria-label="This week">
        <WeekTicket
          me={me}
          week={week}
          setWeek={setWeek}
          loadError={weekError}
          onRetry={() => void loadWeek(weekStart)}
          onPrev={() => week && setWeekStart(shift(week.start, -7))}
          onNext={() => week && setWeekStart(shift(week.start, 7))}
          onThisWeek={() => setWeekStart(undefined)}
          onOpenRecipe={setRecipe}
        />
        <PantryCard version={kitchenVersion} />
        <ActivityCard version={kitchenVersion} />
        <FavesCard profiles={profiles} />
      </aside>

      <nav className="tabs" aria-label="Sections">
        <button aria-current={tab === "chat" ? "page" : undefined} onClick={() => switchTab("chat")}><ChatIcon />Chat</button>
        <button aria-current={tab === "week" ? "page" : undefined} onClick={() => switchTab("week")}><TicketIcon />This week</button>
        <button aria-current={tab === "profiles" ? "page" : undefined} onClick={() => switchTab("profiles")}><PeopleIcon />Profiles</button>
      </nav>

      <div className={`scrim${sheet ? " open" : ""}`} onClick={() => setSheet(false)} />
      <div className={`sheet${sheet ? " open" : ""}`} role="dialog" aria-modal="true" aria-label="Menu" hidden={!sheet}>
        <div className="grab" />
        <div className="who">{avatar}<span><b>{me.name}</b><small>{mealieLine}</small></span></div>
        {installState === "prompt" && (
          <button className="item" onClick={() => void install()}><DownloadIcon />Add Sal to your home screen</button>
        )}
        {installState === "ios" && (
          <>
            <button className="item" onClick={() => setShowIosHelp((v) => !v)} aria-expanded={showIosHelp}><DownloadIcon />Add Sal to your home screen</button>
            {showIosHelp && (
              <p className="install-help">
                In Safari, tap the Share button (the square with an arrow), then <b>Add to Home Screen</b>. Sal opens full screen from there, like an app.
              </p>
            )}
          </>
        )}
        <button className="item" onClick={newConversation} disabled={chatBusy}><FreshIcon />Start a new conversation</button>
        <button className="item" onClick={() => switchTab("past")}><ClockIcon />Earlier conversations</button>
        <button className="item" onClick={() => switchTab("settings")}><GearIcon />Settings and reminders</button>
        <button className="item" onClick={signOut}><PowerIcon />Switch person</button>
      </div>
      {recipe && <RecipeSheet slug={recipe} onClose={() => setRecipe(null)} />}
    </div>
  );
}

const DownloadIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
  </svg>
);

function shift(date: string, days: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
