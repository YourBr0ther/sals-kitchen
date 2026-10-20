import OpenAI from "openai";
import { describeLlmError } from "./llm";

/** An error whose message is written for the family and safe to show them. */
export class UserError extends Error {}

/**
 * What to tell people about a failure: our own messages as they are, the AI service's
 * translated, and anything else (a bug, a malformed response) logged and replaced.
 */
export function userMessage(e: unknown, fallback: string, where: string): string {
  if (e instanceof UserError) return e.message;
  if (e instanceof OpenAI.APIError) return describeLlmError(e).message;
  console.error(`[${where}]`, e);
  return fallback;
}
