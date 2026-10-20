// Run with: DATA_DIR=$(mktemp -d) TZ=America/New_York npx tsx --test tests/reminders.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { getDb } from "../lib/db";
import { isDue, prepNeed, reminderTime, runOnce, type Deps } from "../lib/reminders";
import { updateSettings } from "../lib/settings";
import { getWeek } from "../lib/week";

test("prepNeed finds what needs starting the night before", () => {
  const cases: [string[], string | null][] = [
    [["2 lb pork shoulder", "Rub with spices and marinate overnight in the fridge."], "to marinate overnight"],
    [["Whisk together the marinade."], "time to marinate"],
    [["Marinate for 30 minutes, then grill."], null],
    [["Marinate for 1 hour."], null],
    [["Marinate at least 4 hours."], "time to marinate"],
    [["1 lb frozen shrimp"], "to thaw overnight"],
    [["Defrost the chicken thighs."], "to thaw overnight"],
    [["1 cup frozen peas, thawed"], null],
    [["Soak the beans overnight. Drain."], "to soak overnight"],
    [["Let the bread soak up the sauce."], null],
    [["Brine the chicken for 8 hours."], "time in the brine"],
    [["Let the dough rise overnight in the fridge."], "a long rise"],
    [["Cover and let rise for 1 hour."], null],
    [["Chill overnight before slicing."], "to start tonight"],
    [["Sear the chicken.", "Add lemon and capers."], null],
  ];
  for (const [lines, want] of cases) assert.equal(prepNeed(lines), want, lines.join(" | "));
});

test("reminderTime follows the household clock across daylight saving", () => {
  assert.equal(reminderTime("2026-10-20", "16:00", "America/New_York").toISOString(), "2026-10-20T20:00:00.000Z");
  assert.equal(reminderTime("2026-11-02", "16:30", "America/New_York").toISOString(), "2026-11-02T21:30:00.000Z");
});

test("isDue catches up for 30 minutes, never later", () => {
  const at = new Date("2026-10-20T20:00:00Z");
  assert.equal(isDue(at, new Date(at.getTime() - 1)), false);
  assert.equal(isDue(at, at), true);
  assert.equal(isDue(at, new Date(at.getTime() + 29 * 60_000 + 59_000)), true);
  assert.equal(isDue(at, new Date(at.getTime() + 30 * 60_000)), false);
});

test("runOnce sends each due reminder once", async () => {
  const d = getDb();
  const { lastInsertRowid } = d.prepare("insert into users (name, role, color) values ('Alex', 'adult', '#F2B33D')").run();
  const alex = Number(lastInsertRowid);
  d.prepare("insert into push_subscriptions (endpoint, user_id, keys) values ('https://push.example/1', ?, '{}')").run(alex);
  const night = d.prepare("insert into nights (date, cooking, title, recipe_slug) values (?, 1, ?, ?)");
  // Sunday the 25th: piccata tonight, pulled pork tomorrow, and nothing else next week
  night.run("2026-10-25", "Chicken piccata", "chicken-piccata");
  night.run("2026-10-26", "Pulled pork", "pulled-pork");

  const sent: { title: string; body: string; url: string }[] = [];
  let mealieUp = true;
  const deps: Deps = {
    send: async (_id, msg) => void sent.push(msg),
    week: getWeek,
    recipe: async (slug) => {
      if (!mealieUp) throw new Error("Mealie is down");
      return slug === "pulled-pork"
        ? { ingredients: ["3 lb pork shoulder"], steps: ["Rub and marinate overnight."], totalTime: "8 hr" }
        : { ingredients: ["2 chicken breasts", "capers"], steps: ["Pound thin and sear."], totalTime: "25 min" };
    },
  };
  const at = (local: string) => new Date(`2026-10-25T${local}:00-04:00`);

  assert.equal((await runOnce(at("09:59"), deps)).length, 0);
  await runOnce(at("10:05"), deps);
  assert.deepEqual(sent.pop(), { title: "Next week's ticket is empty", body: "Want Sal to plan it?", url: "/?tab=chat", tag: "sunday-2026-10-25" });
  assert.equal((await runOnce(at("10:06"), deps)).length, 0, "no second Sunday nudge");

  await runOnce(at("16:00"), deps);
  assert.deepEqual(sent.pop(), { title: "Tonight: Chicken piccata", body: "Takes about 25 min.", url: "/?tab=week", tag: "dinner-2026-10-25" });

  await runOnce(at("20:29"), deps);
  assert.deepEqual(sent.pop(), {
    title: "Prep tonight",
    body: "Tomorrow's Pulled pork needs to marinate overnight.",
    url: "/?tab=week",
    tag: "prep-2026-10-26",
  });
  assert.equal(sent.length, 0);

  // a restart that missed the window by more than 30 minutes stays quiet
  d.prepare("delete from notifications_sent").run();
  assert.equal((await runOnce(at("16:31"), deps)).length, 0);

  // Mealie down: the dinner heads-up still goes, without a time
  mealieUp = false;
  await runOnce(at("16:10"), deps);
  assert.equal(sent.pop()?.body, "It's on the week ticket.");

  // turned off: nothing on Monday at 4pm
  updateSettings(alex, { reminders: { dinner: false } });
  assert.equal((await runOnce(new Date("2026-10-26T16:00:00-04:00"), deps)).length, 0);
});
