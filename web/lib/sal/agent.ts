import OpenAI from "openai";
import { addMessage, getActions, imageDataUrl, modelHistory, photosToDescribe, splitChips, updatePayload, type ActionView } from "../chat";
import { describePhoto } from "../vision";
import { config } from "../config";
import type { User } from "../db";
import { getWeek } from "../week";
import { systemPrompt } from "./prompt";
import { runTool, TOOL_LABELS, TOOLS, type ToolContext } from "./tools";

export type SalEvent =
  | { type: "status"; label: string }
  | { type: "text"; delta: string }
  | { type: "done"; messageId: number; text: string; chips: string[]; actions: ActionView[]; changed: string[] }
  | { type: "error"; message: string };

const MAX_STEPS = 8;

let client: OpenAI | undefined;
const llm = () => (client ??= new OpenAI({ baseURL: config.llm.baseURL, apiKey: config.llm.apiKey }));

type ToolCall = OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall;

/**
 * One turn: the user's message is already saved. Loops model -> tools -> model
 * until Sal answers in plain text, saving every step so the next turn has the context.
 */
export async function* runTurn(user: User, signal?: AbortSignal): AsyncGenerator<SalEvent> {
  const ctx: ToolContext = { user, actions: [], changed: new Set() };
  // text Sal wrote before tool calls; the chat shows it together with the final answer
  const said: string[] = [];
  try {
    const pending = photosToDescribe(user.id);
    if (pending) {
      yield { type: "status", label: "Looking at your photo" };
      const notes: string[] = [];
      for (const id of pending.payload.attachments ?? []) {
        const url = imageDataUrl(id);
        notes.push(url ? await describePhoto(url, pending.text).catch((e) => `(couldn't read it: ${(e as Error).message})`) : "(photo missing)");
      }
      updatePayload(pending.id, { ...pending.payload, photoNotes: notes });
    }
    for (let step = 0; step < MAX_STEPS; step++) {
      const week = await getWeek();
      const stream = await llm().chat.completions.create(
        {
          model: config.llm.model,
          messages: [{ role: "system", content: systemPrompt(user, week) }, ...modelHistory(user.id)],
          tools: TOOLS,
          stream: true,
          temperature: 0.8,
        },
        { signal },
      );

      let text = "";
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
          }
        }
        for (const tc of delta.tool_calls ?? []) {
          const slot = (calls[tc.index] ??= { id: "", name: "", args: "" });
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name += tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
        }
      }

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
        const messageId = addMessage(user.id, "assistant", clean, { chips, actions: ctx.actions, display });
        yield { type: "done", messageId, text: display, chips, actions: getActions(ctx.actions), changed: [...ctx.changed] };
        return;
      }

      if (text.trim()) said.push(text.trim());
      addMessage(user.id, "assistant", text.trim(), { tool_calls: toolCalls });
      if (text.trim()) yield { type: "text", delta: "\n\n" };
      for (const call of toolCalls) {
        yield { type: "status", label: TOOL_LABELS[call.function.name] ?? "Working on it" };
        let result: unknown;
        try {
          result = await runTool(call.function.name, JSON.parse(call.function.arguments || "{}"), ctx);
        } catch (e) {
          result = { error: (e as Error).message };
        }
        addMessage(user.id, "tool", typeof result === "string" ? result : JSON.stringify(result), {
          tool_call_id: call.id,
          name: call.function.name,
        });
      }
    }
    const text = "I've been running around this kitchen too long on that one. Ask me again, simpler?";
    const messageId = addMessage(user.id, "assistant", text, { actions: ctx.actions });
    yield { type: "done", messageId, text, chips: [], actions: getActions(ctx.actions), changed: [...ctx.changed] };
  } catch (e) {
    if (signal?.aborted) return;
    yield { type: "error", message: (e as Error).message };
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
