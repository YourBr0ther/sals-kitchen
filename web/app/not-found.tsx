import Link from "next/link";

export default function NotFound() {
  return (
    <main className="gate">
      <div className="gate-card">
        <img src="/icon.svg" alt="" />
        <h1>Not on the menu</h1>
        <p>There&apos;s no page here.</p>
        <Link className="push" style={{ display: "block", textDecoration: "none" }} href="/">Back to the kitchen</Link>
      </div>
    </main>
  );
}
