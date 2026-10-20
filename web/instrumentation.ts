/** Runs once when the server starts. Reminders need SQLite and timers, so only the Node.js server runs them. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const { startReminders } = await import("./lib/reminders");
  startReminders();
}
