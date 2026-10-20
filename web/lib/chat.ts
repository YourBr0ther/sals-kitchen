import fs from "node:fs";
import path from "node:path";
import type OpenAI from "openai";
import { config } from "./config";
import { getDb } from "./db";
import { currentTurnStart, HISTORY_BUDGET, OLD_TOOL_CHARS, RECENT_TOOL_CHARS, recentFrom, rowCost, windowRows } from "./memory";

type Role = "user" | "assistant" | "tool" | "event" | "reset";

export interface UserPayload {
  attachments?: string[];
  voice?: boolean;
  /** vision model's description of each attached photo */
  photoNotes?: string[];
}
export interface AssistantPayload {
  tool_calls?: OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall[];
  chips?: string[];
  actions?: number[];
  /** everything Sal said this turn, including text before tool calls */
  display?: string;
  /** facts Sal saved to this person's memory during the turn */
  remembered?: string[];
}
export interface ToolPayload {
  tool_call_id: string;
  name: string;
}

type Row = { id: number; role: Role; content: string; payload: string; created_at: string };

export function addMessage(userId: number, role: Role, content: string, payload: object = {}): number {
  const r = getDb()
    .prepare("insert into messages (user_id, role, content, payload) values (?, ?, ?, ?)")
    .run(userId, role, content, JSON.stringify(payload));
  return Number(r.lastInsertRowid);
}

/** Save an assistant tool call and all its results in one transaction. */
export function addToolExchange(
  userId: number,
  text: string,
  calls: OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall[],
  results: { id: string; name: string; content: string }[],
) {
  getDb().transaction(() => {
    addMessage(userId, "assistant", text, { tool_calls: calls });
    for (const r of results) addMessage(userId, "tool", r.content, { tool_call_id: r.id, name: r.name });
  })();
}

export function uploadPath(id: string) {
  return path.join(config.dataDir, "uploads", id.replace(/[^a-zA-Z0-9_-]/g, ""));
}

export function imageDataUrl(id: string, userId: number): string | null {
  const row = getDb().prepare("select mime from uploads where id = ? and user_id = ?").get(id, userId) as { mime: string } | undefined;
  const file = uploadPath(id);
  if (!row || !fs.existsSync(file)) return null;
  return `data:${row.mime};base64,${fs.readFileSync(file).toString("base64")}`;
}

/**
 * The conversation as the model sees it: this person's messages since the last summary,
 * newest first until the budget runs out. Tool results from the last two exchanges are
 * kept long; older ones are trimmed, since a recipe page from three turns ago is mostly noise.
 * Photos appear as their written descriptions.
 */
export function modelHistory(userId: number): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const rows = windowRows(userId);
  const recent = recentFrom(rows);
  const turnStart = currentTurnStart(rows);

  // the turn being answered always goes in whole, so its question is never cut off;
  // if its tool results alone are too big, each one gets a smaller share instead
  const turnTools = rows.slice(turnStart).filter((r) => r.role === "tool");
  const turnOther = rows.slice(turnStart).reduce((n, r) => n + (r.role === "tool" ? 0 : rowCost(r, true)), 0);
  const turnToolCap = turnTools.length
    ? Math.max(800, Math.min(RECENT_TOOL_CHARS, Math.floor((HISTORY_BUDGET - turnOther) / turnTools.length)))
    : RECENT_TOOL_CHARS;
  let used = rows.slice(turnStart).reduce((n, r) => n + (r.role === "tool" ? Math.min(r.content.length, turnToolCap) : rowCost(r, true)), 0);

  // earlier turns fill whatever room is left, newest first
  let start = turnStart;
  for (let i = turnStart - 1; i >= 0; i--) {
    const cost = rowCost(rows[i], i >= recent);
    if (used + cost > HISTORY_BUDGET) break;
    used += cost;
    start = i;
  }
  // never start mid-exchange: tool results need the assistant call that asked for them
  while (start < turnStart && rows[start].role !== "user" && rows[start].role !== "event") start++;

  // an assistant tool call is only valid with every one of its results right after it;
  // anything else (older data, an event that slipped in between) is left out
  const keep = new Set<number>();
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    if (r.role === "tool") continue; // kept only through its call, below
    const calls = r.role === "assistant" ? (JSON.parse(r.payload) as AssistantPayload).tool_calls : undefined;
    if (!calls?.length) {
      keep.add(i);
      continue;
    }
    const ids = new Set(calls.map((c) => c.id));
    let j = i + 1;
    while (j < rows.length && rows[j].role === "tool" && ids.delete((JSON.parse(rows[j].payload) as ToolPayload).tool_call_id)) j++;
    if (ids.size) continue;
    for (let k = i; k < j; k++) keep.add(k);
    i = j - 1;
  }

  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  for (let i = start; i < rows.length; i++) {
    if (!keep.has(i)) continue;
    const r = rows[i];
    const p = JSON.parse(r.payload);
    if (r.role === "user") {
      const u = p as UserPayload;
      const prefix = u.voice ? "(voice note) " : "";
      const notes = (u.photoNotes ?? []).map((n, k) => `\n[photo ${k + 1}: ${n}]`).join("");
      const missing = (u.attachments?.length ?? 0) > (u.photoNotes?.length ?? 0) ? "\n[sent a photo that couldn't be read]" : "";
      out.push({ role: "user", content: prefix + r.content + notes + missing });
    } else if (r.role === "assistant") {
      const a = p as AssistantPayload;
      if (a.tool_calls?.length) out.push({ role: "assistant", content: r.content || null, tool_calls: a.tool_calls });
      else out.push({ role: "assistant", content: r.content });
    } else if (r.role === "tool") {
      const limit = i >= turnStart ? turnToolCap : i >= recent ? RECENT_TOOL_CHARS : OLD_TOOL_CHARS;
      const content = r.content.length > limit ? `${r.content.slice(0, limit)}… (trimmed)` : r.content;
      out.push({ role: "tool", tool_call_id: (p as ToolPayload).tool_call_id, content });
    } else if (r.role === "event") {
      out.push({ role: "user", content: `[app event, not typed by the user] ${r.content}` });
    }
  }
  return out;
}

export interface VisibleMessage {
  id: number;
  role: "user" | "assistant" | "event";
  content: string;
  createdAt: string;
  attachments?: string[];
  voice?: boolean;
  chips?: string[];
  actions?: ActionView[];
  remembered?: string[];
}

export interface ActionView {
  id: number;
  kind: string;
  summary: string;
  status: "pending" | "running" | "approved" | "declined" | "failed";
  result: string | null;
}

export function getActions(ids: number[], userId: number): ActionView[] {
  if (!ids.length) return [];
  return getDb()
    .prepare(`select id, kind, summary, status, result from pending_actions where user_id = ? and id in (${ids.map(() => "?").join(",")})`)
    .all(userId, ...ids) as ActionView[];
}

/**
 * What the chat screen shows: everything except tool plumbing. By default that's the
 * current conversation (since the last "new conversation"); pass a range for an old one.
 */
export function visibleMessages(userId: number, range?: { after: number; through: number }, limit = 80): VisibleMessage[] {
  const d = getDb();
  const after = range?.after ?? lastResetId(userId);
  const through = range?.through ?? Number.MAX_SAFE_INTEGER;
  const rows = d
    .prepare(
      `select * from messages where user_id = ? and id > ? and id <= ? and role in ('user', 'assistant', 'event')
       order by id desc limit ?`,
    )
    .all(userId, after, through, limit) as Row[];
  const out: VisibleMessage[] = [];
  for (const r of rows.reverse()) {
    const p = JSON.parse(r.payload);
    // tool-call steps are folded into the turn's final message via `display`
    if (r.role === "assistant" && (p.tool_calls || !(p.display ?? r.content).trim())) continue;
    out.push({
      id: r.id,
      role: r.role as VisibleMessage["role"],
      // app events carry recipe slugs for Sal; people don't need to see them
      content: r.role === "assistant" ? (p.display ?? r.content) : r.role === "event" ? r.content.replace(/ \(slug [^)]+\)/g, "") : r.content,
      createdAt: r.created_at,
      attachments: p.attachments,
      voice: p.voice,
      chips: p.chips,
      actions: p.actions ? getActions(p.actions, userId) : undefined,
      remembered: p.remembered,
    });
  }
  return out;
}

const lastResetId = (userId: number) =>
  (getDb().prepare("select coalesce(max(id), 0) as id from messages where user_id = ? and role = 'reset'").get(userId) as { id: number }).id;

export interface ConversationSummary {
  /** messages after this id and up to `through` belong to it */
  after: number;
  through: number;
  startedAt: string;
  endedAt: string;
  preview: string;
  messages: number;
}

/** Earlier conversations, newest first. Each one ends where someone started a new one. */
export function pastConversations(userId: number, limit = 60): ConversationSummary[] {
  const rows = getDb()
    .prepare(
      `select id, role, content, created_at from messages where user_id = ? and role in ('user', 'reset')
       or (user_id = ? and role = 'assistant' and payload not like '%"tool_calls"%') order by id`,
    )
    .all(userId, userId) as { id: number; role: Role; content: string; created_at: string }[];
  const out: ConversationSummary[] = [];
  let after = 0;
  let first: (typeof rows)[number] | undefined;
  let last: (typeof rows)[number] | undefined;
  let count = 0;
  for (const r of rows) {
    if (r.role === "reset") {
      if (count) {
        out.push({
          after,
          through: r.id,
          startedAt: first!.created_at,
          endedAt: last!.created_at,
          preview: rows.find((x) => x.id > after && x.role === "user" && x.content.trim())?.content.slice(0, 120) ?? "Photos and voice notes",
          messages: count,
        });
      }
      after = r.id;
      first = last = undefined;
      count = 0;
      continue;
    }
    first ??= r;
    last = r;
    count++;
  }
  return out.reverse().slice(0, limit);
}

/** Sal ends some replies with a "Replies: a | b | c" line; split it off into tap-to-send chips. */
export function splitChips(text: string): { text: string; chips: string[] } {
  const m = text.match(/\n*\s*replies:\s*(.+?)\s*$/i);
  if (!m) return { text: text.trim(), chips: [] };
  const chips = m[1]
    .split("|")
    .map((c) => c.trim().replace(/^["'*]+|["'*]+$/g, ""))
    .filter((c) => c && c.length <= 60)
    .slice(0, 4);
  return { text: text.slice(0, m.index).trim(), chips };
}

export function updatePayload(messageId: number, payload: object) {
  getDb().prepare("update messages set payload = ? where id = ?").run(JSON.stringify(payload), messageId);
}

/** The newest user message, if its photos haven't been described yet. */
export function photosToDescribe(userId: number): { id: number; text: string; payload: UserPayload } | undefined {
  const r = getDb()
    .prepare("select * from messages where user_id = ? and role = 'user' order by id desc limit 1")
    .get(userId) as Row | undefined;
  if (!r) return;
  const payload = JSON.parse(r.payload) as UserPayload;
  if (!payload.attachments?.length || payload.photoNotes) return;
  return { id: r.id, text: r.content, payload };
}
