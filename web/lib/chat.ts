import fs from "node:fs";
import path from "node:path";
import type OpenAI from "openai";
import { config } from "./config";
import { getDb } from "./db";

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

function rowsSinceReset(userId: number, limit: number): Row[] {
  const reset = getDb()
    .prepare("select coalesce(max(id), 0) as id from messages where user_id = ? and role = 'reset'")
    .get(userId) as { id: number };
  const rows = getDb()
    .prepare("select * from messages where user_id = ? and id > ? order by id desc limit ?")
    .all(userId, reset.id, limit) as Row[];
  return rows.reverse();
}

export function uploadPath(id: string) {
  return path.join(config.dataDir, "uploads", id.replace(/[^a-zA-Z0-9_-]/g, ""));
}

export function imageDataUrl(id: string): string | null {
  const row = getDb().prepare("select mime from uploads where id = ?").get(id) as { mime: string } | undefined;
  const file = uploadPath(id);
  if (!row || !fs.existsSync(file)) return null;
  return `data:${row.mime};base64,${fs.readFileSync(file).toString("base64")}`;
}

const MAX_TOOL_CHARS = 6000;

/** The conversation as the model sees it. Photos appear as their written descriptions. */
export function modelHistory(userId: number): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const rows = rowsSinceReset(userId, 60);
  // drop leading tool results whose assistant call got cut off by the limit
  while (rows.length && (rows[0].role === "tool" || (rows[0].role === "assistant" && JSON.parse(rows[0].payload).tool_calls))) rows.shift();

  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  for (const r of rows) {
    const p = JSON.parse(r.payload);
    if (r.role === "user") {
      const u = p as UserPayload;
      const prefix = u.voice ? "(voice note) " : "";
      const notes = (u.photoNotes ?? []).map((n, i) => `\n[photo ${i + 1}: ${n}]`).join("");
      const missing = (u.attachments?.length ?? 0) > (u.photoNotes?.length ?? 0) ? "\n[sent a photo that couldn't be read]" : "";
      out.push({ role: "user", content: prefix + r.content + notes + missing });
    } else if (r.role === "assistant") {
      const a = p as AssistantPayload;
      if (a.tool_calls?.length) out.push({ role: "assistant", content: r.content || null, tool_calls: a.tool_calls });
      else out.push({ role: "assistant", content: r.content });
    } else if (r.role === "tool") {
      out.push({ role: "tool", tool_call_id: (p as ToolPayload).tool_call_id, content: r.content.slice(0, MAX_TOOL_CHARS) });
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
}

export interface ActionView {
  id: number;
  kind: string;
  summary: string;
  status: "pending" | "approved" | "declined" | "failed";
  result: string | null;
}

export function getActions(ids: number[]): ActionView[] {
  if (!ids.length) return [];
  const rows = getDb()
    .prepare(`select id, kind, summary, status, result from pending_actions where id in (${ids.map(() => "?").join(",")})`)
    .all(...ids) as ActionView[];
  return rows;
}

/** What the chat screen shows: everything except tool plumbing. */
export function visibleMessages(userId: number, limit = 80): VisibleMessage[] {
  const rows = getDb()
    .prepare(
      `select * from messages where user_id = ? and role in ('user', 'assistant', 'event', 'reset')
       order by id desc limit ?`,
    )
    .all(userId, limit) as Row[];
  const out: VisibleMessage[] = [];
  for (const r of rows.reverse()) {
    const p = JSON.parse(r.payload);
    if (r.role === "reset") {
      out.push({ id: r.id, role: "event", content: "New conversation", createdAt: r.created_at });
      continue;
    }
    // tool-call steps are folded into the turn's final message via `display`
    if (r.role === "assistant" && (p.tool_calls || !(p.display ?? r.content).trim())) continue;
    out.push({
      id: r.id,
      role: r.role as VisibleMessage["role"],
      content: r.role === "assistant" ? (p.display ?? r.content) : r.content,
      createdAt: r.created_at,
      attachments: p.attachments,
      voice: p.voice,
      chips: p.chips,
      actions: p.actions ? getActions(p.actions) : undefined,
    });
  }
  return out;
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
