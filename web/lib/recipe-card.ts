import { elementAt, findClass, htmlToText } from "./html";

/**
 * Details recipe-card plugins show on the page but leave out of their schema.org data:
 * ingredient group headings ("For the sauce") and the recipe's own notes or tips.
 */

export interface Heading {
  /** index of the first line under this heading */
  at: number;
  title: string;
}

export interface Note {
  title: string;
  text: string;
}

const tidyHeading = (s: string) => s.replace(/\s+/g, " ").replace(/[\s:]+$/, "").trim();

// Ingredient containers of the common plugins. WP Recipe Maker marks its group headings and
// items with classes; the others use plain headings and list items inside the container.
const INGREDIENT_CARDS: { container: string; heading?: RegExp; item?: RegExp }[] = [
  { container: "wprm-recipe-ingredients-container", heading: /wprm-recipe-group-name/, item: /class=["'][^"']*\bwprm-recipe-ingredient["'\s]/ },
  { container: "tasty-recipes-ingredients" },
  { container: "mv-create-ingredients" },
];

/**
 * Group headings for a page's ingredient list, positioned against the schema.org list.
 * Only trusted when the card has exactly as many items as the schema list, so a heading
 * can't land on the wrong line.
 */
export function ingredientHeadings(html: string, expectedCount: number): Heading[] | undefined {
  for (const card of INGREDIENT_CARDS) {
    const start = findClass(html, card.container);
    if (start < 0) continue;
    const el = elementAt(html, start);
    if (!el) continue;
    const headings: Heading[] = [];
    let count = 0;
    let pending: string | null = null;
    for (const m of el.matchAll(/<(h[2-6])\b([^>]*)>([\s\S]*?)<\/\1>|<li\b[^>]*>/gi)) {
      if (m[1]) {
        if (card.heading && !card.heading.test(m[2])) continue;
        const title = tidyHeading(htmlToText(m[3]));
        if (title && !/^ingredients?$/i.test(title)) pending = title;
        continue;
      }
      if (card.item && !card.item.test(m[0])) continue;
      if (pending) headings.push({ at: count, title: pending });
      pending = null;
      count++;
    }
    if (count !== expectedCount) return;
    return headings.length ? headings : undefined;
  }
}

// Containers the page itself labels as the recipe's notes or tips, with a title if it has none.
const NOTE_CARDS: [string, string][] = [
  ["wprm-recipe-notes", "Recipe notes"],
  ["tasty-recipes-notes-body", "Notes"],
  ["tasty-recipes-notes", "Notes"],
  ["mv-create-notes-content", "Notes"],
  ["recipe__tips", "Tips"], // King Arthur's "Tips from our Bakers"
];

/** The recipe's own notes section, if the card has one. */
export function recipeNotes(html: string): Note[] {
  for (const [cls, fallbackTitle] of NOTE_CARDS) {
    const start = findClass(html, cls);
    if (start < 0) continue;
    const el = elementAt(html, start);
    if (!el) continue;
    const headingHtml = el.match(/^<[^>]+>\s*<(h[2-6])\b[^>]*>([\s\S]*?)<\/\1>/i);
    const title = headingHtml ? tidyHeading(htmlToText(headingHtml[2])) : fallbackTitle;
    const lines = htmlToText(headingHtml ? el.replace(headingHtml[0], "") : el)
      .split("\n")
      // list markers ("- *") would render as nested bullets; each note is its own paragraph instead
      .map((l) => l.replace(/^(?:[-*•]\s*)+/, "").trim())
      .filter((l) => l && !/^(recipe )?notes:?$/i.test(l));
    const text = lines.join("\n\n").slice(0, 5000);
    if (text.length >= 20) return [{ title: title || fallbackTitle, text }];
  }
  return [];
}
