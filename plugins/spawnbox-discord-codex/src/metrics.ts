import { readFileSync } from "node:fs";
import { join } from "node:path";

export const infraPredicate = "index1 = 'infrastructure' AND ((blob1 = 'daemon_service_state_change' AND blob8 IN ('error', 'warning')) OR (blob1 = 'daemon_incident' AND blob6 != 'port_mapping'))";
export const metricNames = ["infra_failure_count_1h", "error_count_1h", "error_count_24h", "event_volume_1h"] as const;
export type Metric = typeof metricNames[number];

export function metricQueries(metric: Metric, at?: string, now = Date.now()) {
  if (!metricNames.includes(metric)) throw new Error("Unsupported aggregate metric");
  if (at && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(at)) throw new Error("Metric time must be a UTC ISO timestamp");
  const end = Math.floor((at ? Date.parse(at) : now) / 1000);
  if (!Number.isFinite(end) || end * 1000 > now + 60000 || end * 1000 < now - 7 * 86400000)
    throw new Error("Metric time must be within the past seven days");
  if (at && new Date(Date.parse(at)).toISOString() !== (at.includes(".") ? at : at.replace("Z", ".000Z")))
    throw new Error("Metric time is not a valid calendar date");
  const hours = metric === "error_count_24h" ? 24 : 1;
  const start = end - hours * 3600;
  const predicate = metric === "infra_failure_count_1h" ? infraPredicate : metric.startsWith("error_") ? "index1 = 'error'" : "1 = 1";
  // Numeric UTC seconds are generated locally, never interpolated participant SQL.
  const where = `${predicate} AND timestamp > toDateTime(${start}) AND timestamp <= toDateTime(${end})`;
  return { metric, start: new Date(start * 1000).toISOString(), end: new Date(end * 1000).toISOString(),
    aggregate: `SELECT COUNT() AS sampled_rows, SUM(_sample_interval) AS estimated_events FROM spawnbox_telemetry WHERE ${where}`,
    buckets: `SELECT toStartOfInterval(timestamp, INTERVAL '5' MINUTE) AS bucket, COUNT() AS sampled_rows, SUM(_sample_interval) AS estimated_events FROM spawnbox_telemetry WHERE ${where} GROUP BY bucket ORDER BY bucket ASC LIMIT 300`,
    rules: `SELECT id,metric,threshold,comparison,enabled,cooldown_minutes FROM telemetry_alert_rules WHERE metric='${metric}' ORDER BY id LIMIT 100`,
    incidents: `SELECT id,group_key,service,severity,state,first_fired_at,last_fired_at,resolved_at,last_notified_at FROM alert_incidents WHERE service='${metric === "error_count_1h" ? "app-errors" : metric}' AND datetime(first_fired_at) <= datetime('${new Date(end * 1000).toISOString()}') AND (resolved_at IS NULL OR datetime(resolved_at) >= datetime('${new Date(start * 1000).toISOString()}')) ORDER BY first_fired_at DESC LIMIT 100`,
  };
}

export function verifyInfraPredicate(projectRoot: string) {
  const source = readFileSync(join(projectRoot, "worker/src/services/event-filters.ts"), "utf8");
  const value = source.match(/export const INFRA_FAILURE_WHERE\s*=\s*"([^"\r\n]+)"\s*;/)?.[1];
  if (value !== infraPredicate) throw new Error("Project infrastructure metric predicate changed; update the reviewed HELP query before using it");
}

export async function queryMetricAE(sql: string, fetcher: typeof fetch = fetch) {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID, token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !/^[a-f0-9]{32}$/.test(account) || !token) throw new Error("Operator Cloudflare account/token is unavailable for aggregate reads");
  const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
    body: sql, redirect: "error", signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Analytics Engine query failed (HTTP ${response.status}); no metric value inferred`);
  const body = await response.text();
  if (body.length > 1024 * 1024) throw new Error("Analytics Engine response exceeds the bounded metric reader");
  let parsed: any;
  try { parsed = JSON.parse(body); } catch { throw new Error("Analytics Engine returned non-JSON; verify token scope and service response"); }
  if (parsed.success === false || (Array.isArray(parsed.errors) && parsed.errors.length) || !Array.isArray(parsed.data)) throw new Error("Analytics Engine result has no valid data array; no metric value inferred");
  return parsed.data;
}
