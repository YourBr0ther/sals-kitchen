import dns from "node:dns/promises";
import net from "node:net";
import { config } from "./config";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export async function webSearch(query: string): Promise<SearchResult[]> {
  const res = await fetch(`${config.nanogpt.url}/api/web`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.llm.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, provider: "linkup", depth: "standard", outputType: "searchResults" }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`Web search failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { data?: unknown };
  const items = Array.isArray(body.data) ? body.data : [];
  return items.slice(0, 8).map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      title: String(r.name ?? r.title ?? ""),
      url: String(r.url ?? r.link ?? ""),
      snippet: String(r.content ?? r.snippet ?? r.description ?? "").replace(/\s+/g, " ").slice(0, 400),
    };
  });
}

function isPrivateAddress(ip: string): boolean {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** Pages come from links people paste and from web search, so keep the fetcher off the home network. */
async function assertPublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https links work.");
  const addrs = net.isIP(url.hostname) ? [{ address: url.hostname }] : await dns.lookup(url.hostname, { all: true });
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new Error("That link points at a private network address.");
  return url;
}

const MAX_BYTES = 3_000_000;

async function fetchText(raw: string): Promise<string> {
  let url = await assertPublicUrl(raw);
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(url, {
      redirect: "manual",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SalsKitchen/1.0)", Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = await assertPublicUrl(new URL(res.headers.get("location")!, url).toString());
      continue;
    }
    if (!res.ok) throw new Error(`The page returned ${res.status}.`);
    const reader = res.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    reader.cancel().catch(() => {});
    return Buffer.concat(chunks).toString("utf8");
  }
  throw new Error("Too many redirects.");
}

type Json = Record<string, unknown>;

function findRecipe(node: unknown): Json | undefined {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = findRecipe(n);
      if (r) return r;
    }
    return;
  }
  const obj = node as Json;
  const type = obj["@type"];
  if (type === "Recipe" || (Array.isArray(type) && type.includes("Recipe"))) return obj;
  return findRecipe(obj["@graph"]);
}

const textOf = (v: unknown): string[] => {
  if (!v) return [];
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(textOf);
  const o = v as Json;
  if (o.itemListElement) return textOf(o.itemListElement);
  return o.text ? [String(o.text)] : o.name ? [String(o.name)] : [];
};

const decode = (s: string) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

export async function readPage(url: string) {
  const html = await fetchText(url);
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const recipe = findRecipe(JSON.parse(m[1]));
      if (recipe) {
        return {
          url,
          kind: "recipe" as const,
          name: decode(String(recipe.name ?? "")),
          description: decode(String(recipe.description ?? "")).slice(0, 400),
          totalTime: recipe.totalTime ?? null,
          servings: textOf(recipe.recipeYield)[0] ?? null,
          ingredients: textOf(recipe.recipeIngredient).map(decode).slice(0, 40),
          steps: textOf(recipe.recipeInstructions).map(decode).slice(0, 25),
        };
      }
    } catch {
      // bad JSON-LD blocks are common; try the next one
    }
  }
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "");
  const text = decode(
    html
      .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " "),
  ).trim();
  return { url, kind: "page" as const, title, text: text.slice(0, 6000) };
}
