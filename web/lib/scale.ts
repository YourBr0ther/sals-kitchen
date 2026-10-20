/**
 * Reading amounts out of recipe text: scaling an ingredient line's leading quantity
 * ("1 1/2 cups" times 2 is "3 cups") and finding cooking times in a step ("simmer 10 minutes").
 * Plain string work with no imports, so it runs in the browser and under bare node for tests.
 */

const GLYPHS: Record<string, number> = {
  "½": 1 / 2, "⅓": 1 / 3, "⅔": 2 / 3, "¼": 1 / 4, "¾": 3 / 4,
  "⅕": 1 / 5, "⅖": 2 / 5, "⅗": 3 / 5, "⅘": 4 / 5, "⅙": 1 / 6, "⅚": 5 / 6,
  "⅐": 1 / 7, "⅛": 1 / 8, "⅜": 3 / 8, "⅝": 5 / 8, "⅞": 7 / 8, "⅑": 1 / 9, "⅒": 1 / 10,
};
const G = Object.keys(GLYPHS).join("");

// one amount: "1 1/2", "1½", "1 ½", "3/4", "½", "1.5", "2"; the fraction slash "⁄" counts too
const NUM = `(?:\\d+\\s+\\d+\\s*[/⁄]\\s*\\d+|\\d+\\s*[${G}]|\\d+\\s*[/⁄]\\s*\\d+|[${G}]|\\d+(?:\\.\\d+)?|\\.\\d+)`;
const RANGE_SEP = `\\s*(?:-|–|—|to|or)\\s*`;
const LEADING = new RegExp(`^(\\s*)(${NUM})(?:(${RANGE_SEP})(${NUM}))?`);

/** The value of one amount token, or NaN. */
export function parseAmount(token: string): number {
  const t = token.trim().replace(/⁄/g, "/");
  let m = t.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/);
  if (m) return Number(m[3]) ? Number(m[1]) + Number(m[2]) / Number(m[3]) : NaN;
  m = t.match(new RegExp(`^(\\d*)\\s*([${G}])$`));
  if (m) return Number(m[1] || 0) + GLYPHS[m[2]];
  m = t.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (m) return Number(m[2]) ? Number(m[1]) / Number(m[2]) : NaN;
  return /^(\d+(\.\d+)?|\.\d+)$/.test(t) ? Number(t) : NaN;
}

const FRACTIONS: [number, string][] = [
  [0, ""], [1 / 8, "⅛"], [1 / 4, "¼"], [1 / 3, "⅓"], [1 / 2, "½"], [2 / 3, "⅔"], [3 / 4, "¾"], [1, ""],
];

/**
 * A kitchen-friendly number: whole numbers as integers, the rest rounded to the nearest
 * common fraction ("1½", "⅔"). Ten and up rounds to a whole number; nobody measures 12⅓ eggs.
 * `decimal` keeps a decimal look for amounts the recipe wrote that way ("1.5 kg").
 */
export function formatAmount(n: number, decimal = false): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 10) return String(Math.round(n));
  if (decimal) return String(Math.round(n * 100) / 100);
  let whole = Math.floor(n);
  const rest = n - whole;
  let best = FRACTIONS[0];
  for (const f of FRACTIONS) if (Math.abs(rest - f[0]) < Math.abs(rest - best[0])) best = f;
  if (best[0] === 1) {
    whole += 1;
    best = FRACTIONS[0];
  }
  // never round a real amount away to nothing
  if (whole === 0 && !best[1]) return "⅛";
  return `${whole || ""}${best[1]}`;
}

/**
 * Scale the amount at the start of an ingredient line. Only the leading amount changes:
 * "1 (14 oz) can" keeps its 14 oz, and lines like "salt to taste" or "9x13 pan" come back as is.
 */
export function scaleLine(line: string, factor: number): string {
  if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return line;
  const m = line.match(LEADING);
  if (!m) return line;
  const rest = line.slice(m[0].length);
  // a size or temperature, not an amount: "9x13 pan", "8-inch", "350°F"
  if (/^\s*[x×]\s*\d/i.test(rest) || /^[-–]?\s*(inch|in\b|"|″|°)/i.test(rest) || /^[\d/⁄.]/.test(rest)) return line;
  const first = parseAmount(m[2]);
  if (Number.isNaN(first)) return line;
  const decimal = (t: string) => /\d\.\d|^\.\d/.test(t.trim());
  let out = formatAmount(first * factor, decimal(m[2]));
  if (m[4]) {
    const second = parseAmount(m[4]);
    if (Number.isNaN(second)) return line;
    out += `${m[3]}${formatAmount(second * factor, decimal(m[4]))}`;
  }
  return `${m[1]}${out}${rest}`;
}

export interface Duration {
  /** where the time sits in the text, to swap it for a button */
  start: number;
  end: number;
  /** the words as written: "45 to 50 minutes" */
  label: string;
  /** seconds for the countdown; a range counts from its low end, so nothing burns */
  seconds: number;
}

const UNIT = `(seconds?|secs?|minutes?|mins?|hours?|hrs?)`;
const DURATION = new RegExp(
  `(?<![\\w./⁄])(${NUM})(?:${RANGE_SEP}(${NUM}))?\\s*-?\\s*${UNIT}\\b` +
    // "1 hour 15 minutes", "1 hour and 15 minutes"
    `(?:,?\\s*(?:and\\s+)?(${NUM})\\s*(minutes?|mins?)\\b)?`,
  "gi",
);

function unitSeconds(unit: string): number {
  const u = unit.toLowerCase();
  if (u.startsWith("h")) return 3600;
  if (u.startsWith("s")) return 1;
  return 60;
}

/** Cooking times written in a step: "10 minutes", "1 hour", "45 to 50 min", "1½ hours". */
export function findDurations(text: string): Duration[] {
  const out: Duration[] = [];
  for (const m of text.matchAll(DURATION)) {
    const low = parseAmount(m[1]);
    let seconds = low * unitSeconds(m[3]);
    if (m[4]) seconds += parseAmount(m[4]) * unitSeconds(m[5]);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 24 * 3600) continue;
    const start = m.index ?? 0;
    out.push({ start, end: start + m[0].length, label: m[0], seconds: Math.round(seconds) });
  }
  return out;
}
