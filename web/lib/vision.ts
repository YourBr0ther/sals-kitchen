import OpenAI from "openai";
import { config } from "./config";

let client: OpenAI | undefined;
const llm = () => (client ??= new OpenAI({ baseURL: config.llm.baseURL, apiKey: config.llm.apiKey }));

const PROMPT = `You describe photos for a home chef assistant. The family sent this photo while planning meals.
Describe what matters for cooking:
- If it's a fridge, pantry, or groceries: list the foods and ingredients you can identify, with rough amounts, in a few short lines.
- If it's a cookbook page, recipe card, or screen showing a recipe: transcribe it completely and word for word: the name, servings, times, every ingredient with its amount, every step, and any notes. Keep section headings ("For the sauce"). Mark words you can't read as [unclear]. This transcription is used to save the recipe, so don't summarize.
- If it's a plated dish: name the dish and its main components.
- Otherwise: say briefly what it shows.
Plain text only. Don't guess at things you can't see.`;

/** One vision call per photo; the chat model reads the descriptions instead of the images. */
export async function describePhoto(dataUrl: string, userText: string, signal?: AbortSignal): Promise<string> {
  const res = await llm().chat.completions.create({
    model: config.llm.visionModel,
    messages: [
      { role: "system", content: PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: userText ? `They wrote: "${userText}"` : "No message with it." },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    temperature: 0.2,
  }, { signal, timeout: 60_000 });
  return (res.choices[0]?.message?.content ?? "").trim() || "(couldn't make out the photo)";
}
