// v0.1.56: the archive loads the real Postgres client the way the worker does (v0.1.55 failed with "Pool is not a
// constructor": the test used an injected client). Run: npx tsx sim/v056test.ts
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  process.env.RATNET_WORKER = "1";
  process.env.DATABASE_URL = "postgres://u:p@127.0.0.1:1/none"; // nothing listens here: a connection error, not a load error
  const ar = await import("../src/lib/archive");
  const ready = await ar.archiveInit();
  const err = ar.archiveView().error;
  ok(!ready, "no database at that address: not ready");
  ok(!/constructor/i.test(err) && /ECONNREFUSED|connect/i.test(err), `the real client loaded and tried to connect (${err})`);
  ok(!/u:p@/.test(err), "the database URL never shows in the error");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.56 checks passed");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
