import type OpenAI from "openai";
import { addMessage, addToolExchange, getActions, imageDataUrl, modelHistory, photosToDescribe, splitChips, updatePayload, type ActionView } from "../chat";
import { describePhoto } from "../vision";
import { config } from "../config";
import { recentFeedbackLines } from "../feedback";
import { describeLlmError, llm } from "../llm";
import type { User } from "../db";
import { maybeSummarize, webInConversation } from "../memory";
import { getWeek } from "../week";
import { systemPrompt } from "./prompt";
import { runTool, TOOL_LABELS, TOOLS, type ToolContext } from "./tools";

export type SalEvent =
  | { type: "status"; label: string }
  | { type: "text"; delta: string }
  | { type: "done"; messageId: number; text: string; chips: string[]; actions: ActionView[]; changed: string[]; remembered: string[] }
  | { type: "error"; message: string; retryable: boolean };

const MAX_STEPS = 8;

// one turn at a time per person, so a double-tap doesn't run Sal twice;
// each turn's controller lets the person stop it from any of their devices
const turns = new Map<number, AbortController>();
export const isBusy = (userId: number) => turns.has(userId);
/** Claim the person's turn. Returns the signal their Stop button aborts, or null if a turn is already running. */
export function tryStartTurn(userId: number): AbortSignal | null {
  if (turns.has(userId)) return null;
  const stop = new AbortController();
  turns.set(userId, stop);
  return stop.signal;
}
export const releaseTurn = (userId: number) => void turns.delete(userId);
export function stopTurn(userId: number): boolean {
  const t = turns.get(userId);
  if (!t || t.signal.aborted) return false;
  t.abort(new Error("stopped"));
  return true;
}

export { describeLlmError };

type ToolCall = OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall;

/**
 * One turn: the user's message is already saved. Loops model -> tools -> model
 * until Sal answers in plain text, saving every step so the next turn has the context.
 */
export async function* runTurn(user: User, signal?: AbortSignal, stopped?: AbortSignal): AsyncGenerator<SalEvent> {
  const ctx: ToolContext = { user, actions: [], changed: new Set(), remembered: [], webInView: webInConversation(user.id) };
  // text Sal wrote before tool calls; the chat shows it together with the final answer
  const said: string[] = [];
  // what's streamed so far in the current step, kept if the person taps Stop
  let partial = "";
  try {
    const pending = photosToDescribe(user.id);
    if (pending) {
      yield { type: "status", label: "Looking at your photo" };
      const notes: string[] = [];
      for (const id of pending.payload.attachments ?? []) {
        const url = imageDataUrl(id, user.id);
        notes.push(
          url
            ? await describePhoto(url, pending.text, signal).catch((e) => {
                console.warn("[vision]", e);
                return "(couldn't make out this photo)";
              })
            : "(photo missing)",
        );
      }
      updatePayload(pending.id, { ...pending.payload, photoNotes: notes });
    }
    const feedback = await recentFeedbackLines().catch(() => []);
    for (let step = 0; step < MAX_STEPS; step++) {
      const week = await getWeek();
      const stream = await llm().chat.completions.create(
        {
          model: config.llm.model,
          messages: [{ role: "system", content: systemPrompt(user, week, feedback) }, ...modelHistory(user.id)],
          tools: TOOLS,
          stream: true,
          temperature: 0.8,
        },
        { signal, timeout: 90_000 },
      );

      let text = "";
      partial = "";
      const calls: { id: string; name: string; args: string }[] = [];
      let shown = 0;
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          // some models open with a lone space before a tool call
          text += text ? delta.content : delta.content.replace(/^\s+/, "");
          // hold back anything that might be the start of a leaked tool-call marker
          const safe = text.includes("<|") ? text.indexOf("<|") : text.length - (text.endsWith("<") ? 1 : 0);
          if (safe > shown) {
            yield { type: "text", delta: text.slice(shown, safe) };
            shown = safe;
            partial = text.slice(0, safe);
          }
        }
        for (const tc of delta.tool_calls ?? []) {
          const slot = (calls[tc.index] ??= { id: "", name: "", args: "" });
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name += tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
        }
      }

      // an aborted stream can end quietly instead of throwing; treat it as the stop it was
      signal?.throwIfAborted();
      const leaked = parseLeakedToolCalls(text);
      if (leaked.calls.length && !calls.filter(Boolean).length) {
        calls.push(...leaked.calls);
        text = leaked.text;
      } else {
        text = leaked.text;
      }
      const toolCalls: ToolCall[] = calls
        .filter(Boolean)
        .map((c, i) => ({ id: c.id || `call_${step}_${i}`, type: "function", function: { name: c.name, arguments: c.args || "{}" } }));

      if (!toolCalls.length) {
        const { text: clean, chips } = splitChips(text);
        const display = [...said, clean].filter(Boolean).join("\n\n");
        const messageId = addMessage(user.id, "assistant", clean, { chips, actions: ctx.actions, display, remembered: ctx.remembered });
        yield {
          type: "done",
          messageId,
          text: display,
          chips,
          actions: getActions(ctx.actions, user.id),
          changed: [...ctx.changed],
          remembered: ctx.remembered,
        };
        void maybeSummarize(user.id, user.name);
        return;
      }

      if (text.trim()) said.push(text.trim());
      partial = "";
      if (text.trim()) yield { type: "text", delta: "\n\n" };
      const results: { id: string; name: string; content: string }[] = [];
      for (const call of toolCalls) {
        if (signal?.aborted) {
          // keep what already ran (approvals created, memories saved), so a retry doesn't redo it
          const done = new Set(results.map((r) => r.id));
          if (results.length) addToolExchange(user.id, text.trim(), toolCalls.filter((c) => done.has(c.id)), results);
          signal.throwIfAborted();
        }
        yield { type: "status", label: TOOL_LABELS[call.function.name] ?? "Working on it" };
        let result: unknown;
        try {
          result = await runTool(call.function.name, JSON.parse(call.function.arguments || "{}"), ctx);
        } catch (e) {
          console.warn(`[tool] ${call.function.name} failed:`, e);
          result = { error: (e as Error).message };
        }
        results.push({ id: call.id, name: call.function.name, content: typeof result === "string" ? result : JSON.stringify(result) });
      }
      // the call and its results are saved together, so an interrupted turn can't leave a call with no answer
      addToolExchange(user.id, text.trim(), toolCalls, results);
    }
    const text = "I've been running around this kitchen too long on that one. Ask me again, simpler?";
    const messageId = addMessage(user.id, "assistant", text, { actions: ctx.actions, remembered: ctx.remembered });
    yield { type: "done", messageId, text, chips: [], actions: getActions(ctx.actions, user.id), changed: [...ctx.changed], remembered: ctx.remembered };
  } catch (e) {
    if (stopped?.aborted) {
      // keep whatever he'd said, so the conversation still reads right
      // (text from before tool calls is already in the saved tool steps; display repeats it for the screen)
      const last = partial.trim() ? `${partial.trim()} …` : "(stopped before finishing)";
      const shown = [...said, last].join("\n\n");
      const messageId = addMessage(user.id, "assistant", last, { actions: ctx.actions, display: shown, remembered: ctx.remembered, stopped: true });
      yield { type: "done", messageId, text: shown, chips: [], actions: getActions(ctx.actions, user.id), changed: [...ctx.changed], remembered: ctx.remembered };
      return;
    }
    console.error(`[chat] turn for user ${user.id} failed:`, e);
    if (signal?.aborted) {
      yield { type: "error", message: "That took Sal too long, so he stopped. Try again, maybe with a simpler ask.", retryable: true };
      return;
    }
    yield { type: "error", ...describeLlmError(e) };
  }
}

/**
 * Kimi models sometimes emit tool calls as raw special tokens in the text instead of
 * structured tool_calls. Pull them back out so the turn keeps working.
 */
export function parseLeakedToolCalls(text: string): { text: string; calls: { id: string; name: string; args: string }[] } {
  const start = text.indexOf("<|tool_call");
  if (start < 0) return { text, calls: [] };
  const calls: { id: string; name: string; args: string }[] = [];
  const re = /<\|tool_call_begin\|>\s*(?:functions\.)?([\w-]+)(?::(\d+))?\s*<\|tool_call_argument_begin\|>\s*([\s\S]*?)\s*<\|tool_call_end\|>/g;
  for (const m of text.slice(start).matchAll(re)) {
    calls.push({ id: `leaked_${m[1]}_${m[2] ?? calls.length}_${Date.now()}`, name: m[1], args: m[3] });
  }
  return { text: text.slice(0, start).trim(), calls };
}
