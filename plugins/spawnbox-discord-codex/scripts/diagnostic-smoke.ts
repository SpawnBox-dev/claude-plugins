import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config";
import { Store } from "../src/store";
import { Diagnostics } from "../src/diagnostics";
const config = loadConfig(process.argv[2]);
const dir = mkdtempSync(join(tmpdir(), "help-versions-check-"));
const store = new Store(join(dir, "help.db"));
if (process.argv[3]) {
  const env = JSON.parse(readFileSync(process.argv[3], "utf8")).env || {};
  for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"])
    if (typeof env[key] === "string") process.env[key] = env[key];
}
try {
  const result = (await new Diagnostics(config, store, dir).read(
    {
      event: {} as any,
      conversation: "fixture",
      lease: "fixture",
      attempts: 1,
    },
    { action: "versions" },
  )) as any;
  console.log(
    JSON.stringify({
      ok: true,
      readOnly: true,
      versionRows: result.versions.length,
      latest: result.versions[0]?.version,
    }),
  );
} finally {
  store.close();
}
