// v0.1.99: the tip goes to Helius Sender's designated accounts (Sender rejects a tx without one). Run: npx tsx sim/v099test.ts
import { PublicKey } from "@solana/web3.js";
let fail = 0;
const ok = (c: boolean, m: string) => {
  console.log(c ? "ok  " : "FAIL", m);
  if (!c) fail++;
};
(async () => {
  const fs = await import("fs");
  const E = await import("../src/lib/exec");
  ok(E.TIP.length === 10, `${E.TIP.length} Sender tip accounts`);
  let valid = true;
  for (const a of E.TIP) {
    try {
      new PublicKey(a);
    } catch {
      valid = false;
    }
  }
  ok(valid, "every one a valid address (each checked active on chain, 16 Oct)");
  ok(E.TIP.includes("4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE") && !E.TIP.includes("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"), "Helius's accounts, not Jito's");
  const src = fs.readFileSync("src/lib/exec.ts", "utf8");
  ok(/const tips = new Set\(TIP\)/.test(src) && /TIP\[Math\.floor\(Math\.random\(\) \* TIP\.length\)\]/.test(src), "the tip and the signing check use the same list");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  ok(Number(pkg.version.split(".")[2]) >= 99 && fs.readFileSync("src/config/build.ts", "utf8").includes(`"${pkg.version}"`), "v0.1.99 or later");
  console.log(fail ? `\n${fail} FAILED` : "\nall v0.1.99 checks pass");
  process.exit(fail ? 1 : 0);
})();
