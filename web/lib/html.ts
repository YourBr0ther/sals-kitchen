/** Small HTML helpers for reading recipe pages without a DOM parser. */

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&rsquo;|&lsquo;/g, "'")
    .replace(/&rdquo;|&ldquo;/g, '"')
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—")
    .replace(/&Prime;/g, "″")
    .replace(/&frac12;/g, "½")
    .replace(/&frac14;/g, "¼")
    .replace(/&frac34;/g, "¾")
    .replace(/&deg;/g, "°")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Plain text with one line per paragraph, list item, heading or block. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|nav|iframe|form)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(br|\/p|\/li|\/h\d|\/div|\/tr)[^>]*>/gi, "\n")
      // WP Recipe Maker lays out notes as block spans rather than paragraphs
      .replace(/<span[^>]*display:\s*block[^>]*>/gi, "\n")
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/**
 * The whole element whose opening tag starts at `start`, matched by counting nested tags of
 * the same name. Undefined if the HTML ends first.
 */
export function elementAt(html: string, start: number): string | undefined {
  const tag = html.slice(start).match(/^<([a-z0-9]+)/i)?.[1];
  if (!tag) return;
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
}

/** Where the opening tag of the first element carrying `className` starts, or -1. */
export function findClass(html: string, className: string, from = 0): number {
  const re = new RegExp(`class=["'](?:[^"']*\\s)?${className}(?:\\s[^"']*)?["']`, "gi");
  re.lastIndex = from;
  const m = re.exec(html);
  return m ? html.lastIndexOf("<", m.index) : -1;
}
