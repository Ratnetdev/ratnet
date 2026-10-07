// Shown at once on every page change while the next page loads on the server.
export default function Loading() {
  return (
    <div className="route-loading" aria-busy="true">
      <div className="prompt">~/ratnet ❯ <span>loading…</span></div>
    </div>
  );
}
