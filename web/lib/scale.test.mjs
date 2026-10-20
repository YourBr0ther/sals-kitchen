// Run with: node lib/scale.test.mjs (Node 23.6+ reads the .ts file directly)
import assert from "node:assert/strict";
import { findDurations, formatAmount, scaleLine } from "./scale.ts";

const scaled = [
  // [line, factor, expected]
  ["2 cups flour", 2, "4 cups flour"],
  ["1 cup milk", 0.5, "½ cup milk"],
  ["1/2 cup sugar", 2, "1 cup sugar"],
  ["3/4 cup broth", 2, "1½ cup broth"],
  ["1 1/2 cups rice", 2, "3 cups rice"],
  ["1 1/2 cups rice", 0.5, "¾ cups rice"],
  ["½ tsp salt", 2, "1 tsp salt"],
  ["¼ cup oil", 3, "¾ cup oil"],
  ["1½ lb chicken", 2, "3 lb chicken"],
  ["1 ½ lb chicken", 2, "3 lb chicken"],
  ["⅓ cup honey", 2, "⅔ cup honey"],
  ["⅛ tsp cayenne", 2, "¼ tsp cayenne"],
  ["1/4 tsp nutmeg", 0.5, "⅛ tsp nutmeg"],
  ["1.5 kg potatoes", 2, "3 kg potatoes"],
  ["0.75 l stock", 2, "1.5 l stock"],
  ["2-3 cloves garlic", 2, "4-6 cloves garlic"],
  ["2 to 3 tbsp butter", 2, "4 to 6 tbsp butter"],
  ["1 or 2 jalapeños", 3, "3 or 6 jalapeños"],
  ["1 (14 oz) can tomatoes", 2, "2 (14 oz) can tomatoes"],
  ["1 2-inch piece ginger", 2, "2 2-inch piece ginger"],
  ["9x13 pan", 2, "9x13 pan"],
  ["8-inch skillet", 2, "8-inch skillet"],
  ["salt to taste", 2, "salt to taste"],
  ["a pinch of saffron", 2, "a pinch of saffron"],
  ["Kosher salt", 3, "Kosher salt"],
  ["400 g pasta", 1.5, "600 g pasta"],
  ["12 tortillas", 0.5, "6 tortillas"],
  ["3 eggs", 1, "3 eggs"],
  ["2 eggs", 1 / 3, "⅔ eggs"],
  ["1 tomato", 2, "2 tomato"],
];
// only amounts change; units and words stay as written ("1½ cup", "2 tomato")
for (const [line, factor, want] of scaled) {
  assert.equal(scaleLine(line, factor), want, `scaleLine(${JSON.stringify(line)}, ${factor})`);
}

assert.equal(formatAmount(2), "2");
assert.equal(formatAmount(2.5), "2½");
assert.equal(formatAmount(0.33), "⅓");
assert.equal(formatAmount(0.7), "⅔");
assert.equal(formatAmount(1.97), "2");
assert.equal(formatAmount(12.4), "12");
assert.equal(formatAmount(0.01), "⅛");

const times = (text) => findDurations(text).map((d) => [d.label, d.seconds]);
assert.deepEqual(times("Simmer for 10 minutes, stirring."), [["10 minutes", 600]]);
assert.deepEqual(times("Bake 1 hour."), [["1 hour", 3600]]);
assert.deepEqual(times("Roast 45 to 50 min until golden."), [["45 to 50 min", 2700]]);
assert.deepEqual(times("Braise 1½ hours."), [["1½ hours", 5400]]);
assert.deepEqual(times("Cook 1 1/2 hours"), [["1 1/2 hours", 5400]]);
assert.deepEqual(times("Rest 30 seconds"), [["30 seconds", 30]]);
assert.deepEqual(times("Bake 1 hour and 15 minutes"), [["1 hour and 15 minutes", 4500]]);
assert.deepEqual(times("Fry 2-3 minutes per side, then 5 mins more"), [["2-3 minutes", 120], ["5 mins", 300]]);
assert.deepEqual(times("Heat oven to 350°F. Use a 9x13 pan."), []);
assert.deepEqual(times("Cut into 2-inch pieces"), []);

console.log(`scale: ${scaled.length + 7 + 10} checks passed`);
