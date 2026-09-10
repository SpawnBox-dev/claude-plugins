import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { metricQueries, queryMetricAE, verifyInfraPredicate, infraPredicate } from "../src/metrics";
import { validateOperation } from "../src/mcp";
import { Diagnostics } from "../src/diagnostics";

test("metric queries bound UTC windows, project failures and safe D1 projections", () => {
  const now = Date.parse("2026-09-10T19:00:00Z");
  const q = metricQueries("infra_failure_count_1h", "2026-09-10T09:10:39Z", now);
  expect(q.start).toBe("2026-09-10T08:10:39.000Z");
  expect(q.aggregate).toContain(infraPredicate);
  expect(q.aggregate).toContain("COUNT() AS sampled_rows");
  expect(q.aggregate).toContain("SUM(_sample_interval) AS estimated_events");
  expect(q.buckets).toContain("GROUP BY bucket ORDER BY bucket ASC");
  expect(q.incidents).toContain("datetime(resolved_at)");
  for (const sql of [q.rules,q.incidents]) {
    expect(sql).toStartWith("SELECT ");
    expect(sql).not.toMatch(/webhook_url|acked_by|detail_json|SELECT \*/);
  }
  expect(metricQueries("error_count_24h", undefined, now).start).toBe("2026-09-09T19:00:00.000Z");
  expect(metricQueries("error_count_1h", undefined, now).incidents).toContain("service='app-errors'");
  expect(() => metricQueries("custom;DELETE" as any, undefined, now)).toThrow("Unsupported");
  for (const at of ["2026-09-10T09:10:00Z';DELETE", "2026-08-01T00:00:00Z", "2026-09-11T00:00:00Z"])
    expect(() => metricQueries("infra_failure_count_1h",at,now)).toThrow();
  expect(() => validateOperation("diagnostic", {action:"metric",metric:"arbitrary",sql:"SELECT *"})).toThrow();
  expect(() => metricQueries("error_count_1h", "2026-02-30T01:00:00Z",Date.parse("2026-03-03T00:00:00Z"))).toThrow("calendar");
});

test("infrastructure query refuses silent drift from the maintained project predicate", () => {
  const root = mkdtempSync(join(tmpdir(),"help-metric-source-"));
  const dir = join(root,"worker/src/services"); mkdirSync(dir,{recursive:true});
  const source = join(dir,"event-filters.ts");
  writeFileSync(source,`export const INFRA_FAILURE_WHERE =\n  "${infraPredicate}";`);
  expect(() => verifyInfraPredicate(root)).not.toThrow();
  writeFileSync(source,`export const INFRA_FAILURE_WHERE = "changed";`);
  expect(() => verifyInfraPredicate(root)).toThrow("predicate changed");
});

test("AE failures remain failures and reads send credentials only to the fixed account endpoint", async () => {
  const saved = [process.env.CLOUDFLARE_ACCOUNT_ID,process.env.CLOUDFLARE_API_TOKEN];
  process.env.CLOUDFLARE_ACCOUNT_ID="a".repeat(32); process.env.CLOUDFLARE_API_TOKEN="synthetic-test-token";
  try {
    let calls = 0;
    const mock = (async (url: any, options: any) => {
      calls++; expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/analytics_engine/sql`);
      expect(options.redirect).toBe("error"); expect(options.body).toBe("SELECT fixture");
      return new Response(JSON.stringify({data:[{sampled_rows:"0",estimated_events:"0"}]}));
    }) as typeof fetch;
    expect(await queryMetricAE("SELECT fixture",mock)).toEqual([{sampled_rows:"0",estimated_events:"0"}]);
    expect(calls).toBe(1);
    for (const [body,status] of [["denied",403],["<html>Access</html>",200],["{}",200],[JSON.stringify({success:false,data:[]}),200]] as const)
      await expect(queryMetricAE("SELECT fixture",(async()=>new Response(body,{status})) as any)).rejects.toThrow();
  } finally {
    for (const [i,key] of ["CLOUDFLARE_ACCOUNT_ID","CLOUDFLARE_API_TOKEN"].entries())
      if(saved[i]===undefined) delete process.env[key]; else process.env[key]=saved[i];
  }
});

test("public and ordinary private participants cannot read operational metrics", async () => {
  for (const audience of ["public","private","helpers"]) {
    const diagnostic = new Diagnostics({ownerIds:["owner"]} as any,{audience:()=>audience} as any,"fixture");
    await expect(diagnostic.read({conversation:"fixture",event:{isDM:true,userId:"participant"}} as any,
      {action:"metric",metric:"infra_failure_count_1h"})).rejects.toThrow("staff context");
  }
});
