"use client";

/** Last resort when the root layout itself fails; it can't rely on the app's styles. */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100dvh", display: "grid", placeItems: "center", background: "#E4EEE8", fontFamily: "system-ui, sans-serif", padding: 24 }}>
        <div style={{ background: "#fff", borderRadius: 24, padding: "28px 24px", maxWidth: 360, textAlign: "center" }}>
          <h1 style={{ color: "#1E4D3A", fontSize: 22, margin: "0 0 8px" }}>Sal&apos;s Kitchen hit a snag</h1>
          <p style={{ color: "#5A6B63", margin: "0 0 20px" }}>The app couldn&apos;t load. Your chats and the week are saved.</p>
          <button onClick={reset} style={{ border: 0, borderRadius: 12, background: "#1E4D3A", color: "#fff", padding: "12px 20px", font: "inherit", fontWeight: 600, minHeight: 44 }}>
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
