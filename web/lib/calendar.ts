import ical, { type VEvent } from "node-ical";
import { config } from "./config";
import { addDays, localDate, zonedTime } from "./dates";

// All-day events only block cooking when they look like being away from home.
const AWAY = /\b(trip|vacation|travel|away|out of town|camping|holiday)\b|#nocook/i;
const NO_COOK_TAG = /#nocook/i;

export interface BusyEvening {
  date: string;
  reasons: string[];
}

const FRESH_MS = 10 * 60_000;
const RETRY_FAILED_MS = 30_000;
const FEED_TIMEOUT_MS = 15_000;

type Feed = { at: number; events: VEvent[]; ok: boolean; error?: string };
const feeds = new Map<string, Feed>();
let loading: Promise<void> | null = null;

async function fetchFeed(url: string): Promise<VEvent[]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FEED_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`the calendar feed answered ${res.status}`);
  const data = ical.sync.parseICS(await res.text());
  return Object.values(data).filter((item): item is VEvent => item?.type === "VEVENT");
}

/** Refresh stale feeds, at most one refresh at a time. A failed refresh keeps the last good events. */
async function refresh() {
  await Promise.all(
    config.calendarUrls.map(async (url) => {
      const cur = feeds.get(url);
      const age = cur ? Date.now() - cur.at : Infinity;
      if (cur && age < (cur.ok ? FRESH_MS : RETRY_FAILED_MS)) return;
      try {
        feeds.set(url, { at: Date.now(), events: await fetchFeed(url), ok: true });
      } catch (e) {
        const error = e instanceof Error && e.name === "TimeoutError" ? "the calendar feed timed out" : (e as Error).message;
        console.warn(`[calendar] ${error}`);
        feeds.set(url, { at: Date.now(), events: cur?.events ?? [], ok: false, error });
      }
    }),
  );
}

async function loadEvents(): Promise<{ events: VEvent[]; error?: string }> {
  loading ??= refresh().finally(() => {
    loading = null;
  });
  // only wait when some feed has never loaded; otherwise answer from the last copy
  // and let the refresh finish in the background, so a slow feed never stalls the chat
  if (config.calendarUrls.some((u) => !feeds.get(u)?.events.length && !feeds.get(u)?.ok)) await loading;
  const all = config.calendarUrls.map((u) => feeds.get(u));
  const errors = all.filter((f) => f && !f.ok).map((f) => f!.error);
  const neverLoaded = all.some((f) => !f || (!f.ok && !f.events.length));
  return {
    events: all.flatMap((f) => f?.events ?? []),
    error: errors.length ? `${errors[0]}${neverLoaded ? "" : " (showing the last copy that loaded)"}` : undefined,
  };
}

const text = (v: unknown) => (typeof v === "string" ? v : ((v as { val?: string })?.val ?? "Busy"));

/** Calendar date of an all-day value. node-ical gives these as local midnight, so read local fields. */
const dayOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Evenings with something on the calendar that gets in the way of cooking. */
export async function busyEvenings(start: string, days: number): Promise<{ busy: BusyEvening[]; error?: string; configured: boolean }> {
  if (!config.calendarUrls.length) return { busy: [], configured: false };
  const { events, error } = await loadEvents();
  const from = zonedTime(addDays(start, -1), 0);
  const to = zonedTime(addDays(start, days + 1), 0);

  const reasonsByDate = new Map<string, Set<string>>();
  const mark = (date: string, why: string) => {
    if (!reasonsByDate.has(date)) reasonsByDate.set(date, new Set());
    reasonsByDate.get(date)!.add(why.replace(NO_COOK_TAG, "").trim() || "Busy");
  };

  for (const e of events) {
    let instances;
    try {
      // handles repeats, moved instances, and skipped dates
      instances = ical.expandRecurringEvent(e, { from, to, expandOngoing: true });
    } catch {
      continue;
    }
    for (const inst of instances) {
      const ev = inst.event;
      if (ev.status === "CANCELLED" || ev.transparency === "TRANSPARENT") continue;
      const summary = text(inst.summary);
      if (inst.isFullDay) {
        if (!AWAY.test(summary)) continue;
        const last = addDays(dayOf(inst.end), -1);
        for (let d = dayOf(inst.start); d <= last; d = addDays(d, 1)) mark(d, summary);
      } else {
        for (let i = 0; i < days; i++) {
          const date = addDays(start, i);
          const winStart = zonedTime(date, config.eveningStart);
          const winEnd = zonedTime(date, config.eveningEnd);
          if ((inst.start < winEnd && inst.end > winStart) || (NO_COOK_TAG.test(summary) && localDate(inst.start) === date)) {
            mark(date, summary);
          }
        }
      }
    }
  }

  const busy: BusyEvening[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(start, i);
    const reasons = reasonsByDate.get(date);
    if (reasons?.size) busy.push({ date, reasons: [...reasons] });
  }
  return { busy, error, configured: true };
}
