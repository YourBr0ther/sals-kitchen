import dns from "node:dns";
import dnsp from "node:dns/promises";
import net from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch, type Response as UndiciResponse } from "undici";
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

/** Only ordinary public unicast addresses. Covers private, loopback, link-local, CGNAT, multicast, mapped and NAT64 IPv6. */
function isPublicAddress(ip: string): boolean {
  try {
    const addr = ipaddr.process(ip); // unwraps IPv4-mapped IPv6
    return addr.range() === "unicast";
  } catch {
    return false;
  }
}

/**
 * Links come from people and from web search, so keep fetches off the home network.
 * The check happens inside the connection's DNS lookup, so the address that was checked
 * is the one the socket connects to (no DNS rebinding between check and fetch).
 */
const publicOnly = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err, "", 4);
        const list = addresses as unknown as dns.LookupAddress[];
        const bad = list.find((a) => !isPublicAddress(a.address));
        if (bad || !list.length) return callback(new Error("That link points at a private network address."), "", 4);
        if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
        callback(null, list[0].address, list[0].family);
      });
    },
  },
});

/** Throws unless the URL is http(s) and its host resolves only to public addresses. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https links work.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await dnsp.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => !isPublicAddress(a.address))) throw new Error("That link points at a private network address.");
  return url;
}

const MAX_BYTES = 3_000_000;

/** The site answered, but with an error status (blocked, missing, down). */
export class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`The page returned ${status}.`);
  }
}

/**
 * Fetch a page through NanoGPT's fetcher (Sofya). Used when a site blocks us directly;
 * the request runs on their infrastructure, so it never touches the home network.
 */
export async function fetchViaService(url: string): Promise<{ title: string; text: string }> {
  const res = await fetch(`${config.nanogpt.url}/api/web`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.llm.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "sofya", operation: "fetch", urls: [url] }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Couldn't fetch the page (${res.status}).`);
  const body = (await res.json()) as { data?: { title?: string; content?: string; success?: boolean; error?: string }[] };
  const item = body.data?.[0];
  if (!item?.content || item.success === false) throw new Error(item?.error || "Couldn't fetch the page.");
  return { title: item.title ?? "", text: item.content };
}

/** Fetch a page's HTML through the public-only connection, following redirects one checked hop at a time. */
export async function fetchText(raw: string): Promise<{ html: string; finalUrl: string }> {
  let url = await assertPublicUrl(raw);
  for (let hop = 0; hop < 5; hop++) {
    const res = await undiciFetch(url, {
      dispatcher: publicOnly,
      redirect: "manual",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SalsKitchen/1.0)", Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = await assertPublicUrl(new URL(res.headers.get("location")!, url).toString());
      continue;
    }
    if (!res.ok) throw new HttpStatusError(res.status);
    const reader = res.body?.getReader();
    if (!reader) return { html: "", finalUrl: url.toString() };
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    reader.cancel().catch(() => {});
    return { html: Buffer.concat(chunks).toString("utf8"), finalUrl: url.toString() };
  }
  throw new Error("Too many redirects.");
}

const IMAGE_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** Download a recipe photo through the public-only connection. */
export async function fetchImage(raw: string): Promise<{ bytes: Buffer; ext: string } | null> {
  let url = await assertPublicUrl(raw);
  for (let hop = 0; hop < 5; hop++) {
    const res = await undiciFetch(url, { dispatcher: publicOnly, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = await assertPublicUrl(new URL(res.headers.get("location")!, url).toString());
      continue;
    }
    const ext = IMAGE_TYPES[(res.headers.get("content-type") ?? "").split(";")[0].trim()];
    if (!res.ok || !ext) return null;
    const bytes = await readCapped(res, 8_000_000);
    return bytes ? { bytes, ext } : null;
  }
  return null;
}

/** Read a response body, giving up (null) as soon as it passes `max` bytes. */
async function readCapped(res: UndiciResponse, max: number): Promise<Buffer | null> {
  if (Number(res.headers.get("content-length") ?? 0) > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = (await reader.read()) as { done: boolean; value: Uint8Array };
    if (done) break;
    size += value.length;
    if (size > max) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
