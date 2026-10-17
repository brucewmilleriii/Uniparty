import Link from "next/link";

export default function NotFound() {
  return (
    <div className="card">
      <div className="welcome">
        <h1>Member not found</h1>
        <p>
          That member isn’t in the current roster. They may have left office. <Link href="/">Search the roster</Link>.
        </p>
      </div>
    </div>
  );
}
