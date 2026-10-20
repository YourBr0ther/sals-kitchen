// Run with: npm test (needs a throwaway DATA_DIR; the script sets one)
import assert from "node:assert/strict";
import { test } from "node:test";
import { addMessage, addToolExchange, hasPastConversations, modelHistory, pastConversations, visibleMessages } from "../lib/chat";
import { getDb } from "../lib/db";

const call = (id: string, name = "search_recipes") => ({ id, type: "function" as const, function: { name, arguments: "{}" } });
const newUser = (name: string) =>
  Number(getDb().prepare("insert into users (name, role, color, pin_hash) values (?, 'adult', '#fff', null)").run(name).lastInsertRowid);

test("model history keeps whole tool exchanges and drops broken ones", () => {
  const u = newUser("History");
  addMessage(u, "user", "first question");
  addToolExchange(u, "", [call("a"), call("b")], [
    { id: "a", name: "search_recipes", content: "RESULT_A" },
    { id: "b", name: "search_recipes", content: "RESULT_B" },
  ]);
  addMessage(u, "assistant", "answer one", {});
  // a call whose result never got saved in order, with an event in between
  addMessage(u, "user", "second question");
  addMessage(u, "assistant", "", { tool_calls: [call("c")] });
  addMessage(u, "event", "someone approved something");
  addMessage(u, "tool", "ORPHAN_RESULT", { tool_call_id: "c", name: "search_recipes" });
  addMessage(u, "assistant", "answer two", {});
  addMessage(u, "user", "third question");
  addToolExchange(u, "let me look", [call("d", "web_search")], [{ id: "d", name: "web_search", content: "RESULT_D" }]);

  const out = modelHistory(u);
  const tools = out.filter((m) => m.role === "tool").map((m) => (m as { content: string }).content);
  assert.deepEqual(tools, ["RESULT_A", "RESULT_B", "RESULT_D"]);
  out.forEach((m, i) => {
    if (m.role === "tool") assert.ok(out[i - 1].role === "tool" || "tool_calls" in out[i - 1], "a result always follows its call");
  });
});

test("a huge turn keeps its question and shrinks its results", () => {
  const u = newUser("Big");
  addMessage(u, "user", "BIG QUESTION");
  for (let k = 0; k < 8; k++) addToolExchange(u, "", [call(`big${k}`, "read_link")], [{ id: `big${k}`, name: "read_link", content: "x".repeat(9000) }]);
  const out = modelHistory(u);
  const chars = out.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);
  assert.ok(out.some((m) => m.role === "user" && m.content === "BIG QUESTION"));
  assert.equal(out.filter((m) => m.role === "tool").length, 8);
  assert.ok(chars < 40_000, `history stays near its budget (${chars})`);
});

test("past conversations are split at each new conversation and stay private", () => {
  const a = newUser("Past");
  const b = newUser("Other");
  addMessage(a, "user", "plan tacos tuesday");
  addMessage(a, "assistant", "Tacos it is.", { display: "Tacos it is." });
  addMessage(a, "reset", "");
  addMessage(a, "user", "only photos here, no words");
  addMessage(a, "reset", "");
  addMessage(a, "user", "what's for dinner tonight");
  addMessage(b, "user", "jordan's own chat");

  const past = pastConversations(a);
  assert.equal(past.length, 2);
  assert.equal(past[1].preview, "plan tacos tuesday");
  // a preview never borrows a later conversation's words
  assert.equal(past[0].preview, "only photos here, no words");
  assert.ok(hasPastConversations(a));
  assert.ok(!hasPastConversations(b));
  // the chat screen shows only the current conversation
  assert.deepEqual(visibleMessages(a).map((m) => m.content), ["what's for dinner tonight"]);
  assert.deepEqual(visibleMessages(a, { after: past[1].after, through: past[1].through }).map((m) => m.content), ["plan tacos tuesday", "Tacos it is."]);
});
