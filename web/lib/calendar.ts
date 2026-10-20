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

type Occurrence = { start: Date; end: Date; allDay: boolean; summary: string };

let cache: { at: number; events: VEvent[]; error?: string } | undefined;
const CACHE_MS = 10 * 60_000;

async function loadEvents(): Promise<{ events: VEvent[]; error?: string }> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache;
  const events: VEvent[] = [];
  const errors: string[] = [];
  for (const url of config.calendarUrls) {
    try {
      const data = await ical.async.fromURL(url);
      for (const item of Object.values(data)) {
        if (item && item.type === "VEVENT") events.push(item as VEvent);
      }
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  cache = { at: Date.now(), events, error: errors.length ? errors.join("; ") : undefined };
  return cache;
}

const summaryOf = (e: VEvent) => (typeof e.summary === "string" ? e.summary : (e.summary as { val?: string })?.val ?? "Busy");

function occurrences(e: VEvent, from: Date, to: Date): Occurrence[] {
  if (!e.start) return [];
  const allDay = (e as { datetype?: string }).datetype === "date";
  const duration = (e.end ? e.end.getTime() : e.start.getTime() + (allDay ? 86_400_000 : 3_600_000)) - e.start.getTime();
  const summary = summaryOf(e);
  if (!e.rrule) {
    return [{ start: e.start, end: new Date(e.start.getTime() + duration), allDay, summary }];
  }
  const exdates = new Set(Object.values(e.exdate ?? {}).map((d) => localDate(d as Date)));
  const out: Occurrence[] = [];
  for (const start of e.rrule.between(new Date(from.getTime() - duration), to, true)) {
    if (exdates.has(localDate(start))) continue;
    out.push({ start, end: new Date(start.getTime() + duration), allDay, summary });
  }
  // moved or edited single instances of a recurring event
  for (const r of Object.values(e.recurrences ?? {})) {
    const rv = r as VEvent;
    if (rv.start) out.push({ start: rv.start, end: rv.end ?? new Date(rv.start.getTime() + duration), allDay, summary: summaryOf(rv) });
  }
  return out;
}

/** Evenings with something on the calendar that gets in the way of cooking. */
export async function busyEvenings(start: string, days: number): Promise<{ busy: BusyEvening[]; error?: string; configured: boolean }> {
  if (!config.calendarUrls.length) return { busy: [], configured: false };
  const { events, error } = await loadEvents();
  const from = zonedTime(start, 0);
  const to = zonedTime(addDays(start, days), 0);
  const result: BusyEvening[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(start, i);
    const winStart = zonedTime(date, config.eveningStart);
    const winEnd = zonedTime(date, config.eveningEnd);
    const reasons = new Set<string>();
    for (const e of events) {
      for (const o of occurrences(e, from, to)) {
        if (o.allDay) {
          // all-day dates are floating; compare by calendar date
          const first = o.start.toISOString().slice(0, 10);
          const last = addDays(o.end.toISOString().slice(0, 10), -1);
          if (date >= first && date <= last && AWAY.test(o.summary)) reasons.add(o.summary);
        } else if ((o.start < winEnd && o.end > winStart) || (NO_COOK_TAG.test(o.summary) && localDate(o.start) === date)) {
          reasons.add(o.summary);
        }
      }
    }
    if (reasons.size) result.push({ date, reasons: [...reasons].map((r) => r.replace(NO_COOK_TAG, "").trim()) });
  }
  return { busy: result, error, configured: true };
}
