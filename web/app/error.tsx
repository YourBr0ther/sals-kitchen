"use client";

import { useEffect } from "react";

/** Shown if a page crashes while rendering. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main className="gate">
      <div className="gate-card">
        <img src="/icon.svg" alt="" />
        <h1>Kitchen fire</h1>
        <p>Something on this screen broke. Your chats and the week are saved.</p>
        <button className="push" style={{ width: "100%" }} onClick={reset}>Try again</button>
        <button className="link" onClick={() => window.location.assign("/")}>Back to the kitchen</button>
      </div>
    </main>
  );
}
