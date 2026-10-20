import OpenAI from "openai";
import { config } from "./config";
import { UserError } from "./errors";

let client: OpenAI | undefined;
// retries cover connection errors, 408/409/429 and 5xx before any text has streamed
export const llm = () => (client ??= new OpenAI({ baseURL: config.llm.baseURL, apiKey: config.llm.apiKey, timeout: 120_000, maxRetries: 2 }));

/** One chat call that must answer with a JSON object. Throws if the reply isn't one. */
export async function llmJson<T>(system: string, user: string, temperature = 0): Promise<T> {
  const res = await llm().chat.completions.create({
    model: config.llm.model,
    temperature,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  const raw = res.choices[0]?.message?.content ?? "";
  try {
    return JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as T;
  } catch {
    throw new UserError("The AI service gave a garbled answer. Try again.");
  }
}

/** What to tell the family when the AI service fails, and whether trying again could help. */
export function describeLlmError(e: unknown): { message: string; retryable: boolean } {
  if (e instanceof OpenAI.APIConnectionTimeoutError) return { message: "Sal's AI service took too long to answer. Try again.", retryable: true };
  if (e instanceof OpenAI.APIConnectionError) return { message: "Couldn't reach Sal's AI service. Check the connection and try again.", retryable: true };
  if (e instanceof OpenAI.APIError) {
    if (e.status === 401 || e.status === 403) return { message: "Sal's AI service turned down the API key. The key needs replacing.", retryable: false };
    if (e.status === 402) return { message: "The AI account is out of credit or over its limit.", retryable: false };
    if (e.status === 429) return { message: "Sal's AI service is busy right now. Give it a minute and try again.", retryable: true };
    if (e.status && e.status >= 500) return { message: "Sal's AI service is having trouble. Try again in a moment.", retryable: true };
    return { message: `Sal's AI service rejected the request (${e.status ?? "error"}).`, retryable: false };
  }
  return { message: "Something went wrong on Sal's end. Try again.", retryable: true };
}
