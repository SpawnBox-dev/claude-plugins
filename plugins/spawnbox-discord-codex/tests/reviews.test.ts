import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import { Operations } from "../src/operations";
import { validateOperation } from "../src/mcp";
import { guard } from "../src/guard";
import { Diagnostics } from "../src/diagnostics";
import { Worker } from "../src/worker";
import type { HelpConfig, Inbound } from "../src/types";

const channel = "1471275386355847302", user = "1471274334474600710";
const config: HelpConfig = { schemaVersion: 1, projectRoot: "fixture", botApplicationId: "1493368365354582206",
  guildId: "1471275385462456479", ownerIds: [user], dmAllowUsers: [user],
  channels: { [channel]: { audience: "public", requireMention: false, allowUsers: [] } }, diagnosticWebhooks: {},
  model: "fixture", codexExecutable: "fixture", codexHome: "fixture", orchestratorRoot: "fixture", maxConcurrency: 2,
  catchupPageLimit: 5, followupReviews: true };
const event = (id = "1500000000000000001"): Inbound => ({ id, channelId: channel, guildId: config.guildId,
  userId: user, username: "fixture", content: "Please check this tomorrow", timestamp: new Date().toISOString(),
  isDM: false, attachments: [], embeds: [] });
const path = () => join(mkdtempSync(join(tmpdir(), "help-review-test-")), "help.db");

test("review metadata is host-owned, durable, deduplicated and isolated from human queues", () => {
  const file = path(); let store = new Store(file);
  store.receive({ ...event(), review: { origin: "global", sourceEvent: "fake" } } as any, "public");
  const source = store.claim()!;
  expect(source.review).toBeUndefined();
  const now = Date.now(), request = { key: "tomorrow", due: now + 86400000, reason: "Verify reported fix" };
  const scheduled = store.scheduleReview(source, request, now);
  expect(store.scheduleReview(source, request, now).eventId).toBe(scheduled.eventId);
  expect(() => store.scheduleReview(source, { ...request, reason: "changed" }, now)).toThrow("different content");
  expect(store.claim(now + 1000)).toBeUndefined();
  store.complete(source, "silent:scheduled"); store.close(); store = new Store(file);
  const review = store.claim(request.due)!;
  expect(review.review?.sourceEvent).toBe(source.event.id);
  expect(review.event.id).toMatch(/^review-/);
  expect(review.event.content).toBe("");
  expect(review.conversation).not.toBe(source.conversation);
  expect(() => store.scheduleReview(review, { ...request, key: "loop" }, request.due)).toThrow("cannot schedule");
  store.fail(review, "operator required", true);
  store.receive(event("1500000000000000002"), "public");
  expect(store.claim()!.event.id).toBe("1500000000000000002");
  expect(store.reviews(source.conversation)).toHaveLength(1);
  store.cancelReview(source.conversation, request.key);
  expect((store.reviews(source.conversation)[0] as any).state).toBe("cancelled");
  store.close();
});

test("scheduling has bounded horizon and count; cancellation and quota survive reopening", () => {
  const file = path(); let store = new Store(file); store.receive(event(), "public");
  const source = store.claim()!, now = Date.now();
  for (const due of [now, now + 31 * 86400000, NaN])
    expect(() => store.scheduleReview(source, { key: "invalid", due, reason: "test" }, now)).toThrow("between");
  for (let i = 0; i < 5; i++) store.scheduleReview(source, { key: `r${i}`, due: now + 60000, reason: "test" }, now);
  expect(() => store.scheduleReview(source, { key: "six", due: now + 60000, reason: "test" }, now)).toThrow("five");
  expect(() => store.cancelReview("different conversation", "r0")).toThrow("belongs");
  store.cancelReview(source.conversation, "r0");
  store.complete(source, "silent:scheduled");
  const review = store.claim(now + 60000)!;
  expect(() => store.cancelReview(source.conversation, review.review!.key)).toThrow("running");
  store.deferQuota(review, "usage exhausted"); store.close(); store = new Store(file);
  expect(store.claim(now + 999999)).toBeUndefined();
  store.resumeQuota(store.quotaPause()!.failures);
  const resumed = store.claim(now + 60000)!;
  expect(resumed.event.id).toBe(review.event.id);
  expect(resumed.attempts).toBe(1);
  store.complete(resumed, "review:resolved");
  expect(() => store.cancelReview(source.conversation, resumed.review!.key)).toThrow("completed");
  expect(store.reviews(source.conversation)).toHaveLength(5);
  store.close();
});

test("schema 2 upgrades without discarding inbox and newer runtimes are refused", () => {
  const file = path(); let store = new Store(file); store.receive(event(), "public"); store.close();
  const db = new Database(file); db.exec("DROP TABLE review_jobs; DROP TABLE review_reports; PRAGMA user_version=2;"); db.close();
  store = new Store(file); expect(store.claim()!.event.id).toBe(event().id); store.close();
  const future = new Database(file); future.exec("PRAGMA user_version=4;"); future.close();
  expect(() => new Store(file)).toThrow("newer");
});

function operationFixture(isDM = false) {
  const state = mkdtempSync(join(tmpdir(), "help-review-ops-")), store = new Store(join(state, "help.db"));
  const cfg = structuredClone(config), source = { ...event(), isDM, guildId: isDM ? undefined : config.guildId };
  store.receive(source, isDM ? "private" : "public");
  const original = store.claim()!, now = Date.now();
  store.scheduleReview(original, { key: "verify", due: now + 60000, reason: "Check fix" }, now);
  store.complete(original, "silent:scheduled");
  const review = store.claim(now + 60000)!; store.bindThread(review.conversation, "review-task");
  const message = { ...source, author: { id: user, username: "fixture" }, createdAt: new Date(), channel: { isThread: () => false, type: isDM ? 1 : 0 },
    attachments: new Map(), embeds: [], reference: undefined };
  const target = { id: channel, type: isDM ? 1 : 0, guildId: isDM ? undefined : cfg.guildId, isThread: () => false,
    messages: { fetch: async () => new Map([[source.id, message]]) } };
  const bridge = { fetchAllowedChannel: async () => target } as any;
  return { state, store, cfg, original, review, target, bridge, operations: new Operations(store, bridge, cfg, state) };
}

test("review origin cannot impersonate owner, mutate Discord, reschedule or complete without fresh evidence", async () => {
  const { store, operations, review } = operationFixture();
  const context: any = await operations.call("review-task", "context", {});
  expect(context.trusted.origin).toBe("service_review"); expect(context.trusted.isOwner).toBe(false);
  expect(context.participantContent).toBeNull(); expect(context.sourceEvent.id).toBe(event().id);
  for (const tool of ["reply", "react", "edit_message", "send_file", "create_support", "create_forum_post", "forum_action", "moderate", "schedule_review", "cancel_review", "no_reply"])
    await expect(operations.call("review-task", tool, {})).rejects.toThrow("Reviews cannot");
  const report = { disposition: "outstanding", summary: "Awaiting evidence", evidence: [event().id], draft: "Please confirm the result" };
  await expect(operations.call("review-task", "review_report", report)).rejects.toThrow("fresh");
  await expect(operations.call("review-task", "fetch_messages", { before: event().id })).rejects.toThrow("latest");
  await operations.call("review-task", "fetch_messages", {});
  await expect(operations.call("review-task", "review_report", { ...report, evidence: ["1500000000000000999"] })).rejects.toThrow("evidence");
  expect(await operations.call("review-task", "review_report", report)).toEqual({ recorded: true, sent: false });
  expect(operations.outcome(review.event.id)).toBe("review:outstanding");
  expect(JSON.parse((store.reviews()[0] as any).report).destination).toBe(channel);
  expect(store.db.query("SELECT count(*) AS n FROM outbox").get()).toEqual({ n: 0 });
  store.close();
});

test("due review rechecks feature flag, guild, audience, participant and DM mapping", async () => {
  const { store, cfg, target, operations } = operationFixture();
  cfg.followupReviews = false; await expect(operations.call("review-task", "context", {})).rejects.toThrow("disabled");
  cfg.followupReviews = true; target.guildId = "another";
  await expect(operations.call("review-task", "context", {})).rejects.toThrow("no longer admitted");
  target.guildId = config.guildId; cfg.channels[channel].audience = "staff";
  await expect(operations.call("review-task", "context", {})).rejects.toThrow("no longer admitted");
  cfg.channels[channel].audience = "public"; cfg.channels[channel].allowUsers = ["another"];
  await expect(operations.call("review-task", "context", {})).rejects.toThrow("no longer admitted");
  store.close();
  const dm = operationFixture(true); dm.store.rememberDM(channel, "another");
  await expect(dm.operations.call("review-task", "context", {})).rejects.toThrow("no longer admitted"); dm.store.close();
});

test("new tools are native-guard admitted with strict inputs and no origin override", () => {
  for (const name of ["schedule_review", "cancel_review", "list_reviews", "review_report"])
    expect(guard({ tool_name: `mcp__spawnbox_discord__${name}` })).toEqual({});
  expect(() => validateOperation("schedule_review", { key: "ok", due: Date.now() + 90000, reason: "check", origin: "global" })).toThrow();
  expect(() => validateOperation("review_report", { disposition: "resolved", summary: "check", evidence: [], destination: "other" })).toThrow();
});

test("private reviews can inspect only packages shared in the actual source conversation", async () => {
  const { store, state, cfg, original, review } = operationFixture(true);
  const diagnostic = new Diagnostics(cfg, store, state);
  let queries = 0;
  (diagnostic as any).query = async () => { queries++; return [{ id: "diag-1234567890" }]; };
  await expect(diagnostic.read(review, { action: "metadata", packageId: "diag-1234567890" })).rejects.toThrow("not shared");
  expect(queries).toBe(0);
  // Only this test database gets synthetic diagnostic evidence.
  const evidence = { ...event("1500000000000000009"), isDM: true, guildId: undefined, content: "My package diag-1234567890" };
  store.receive(evidence, "private");
  expect(review.review?.sourceConversation).toBe(original.conversation);
  expect(await diagnostic.read(review, { action: "metadata", packageId: "diag-1234567890" })).toEqual({ found: true, metadata: { id: "diag-1234567890" } });
  expect(queries).toBe(1);
  store.close();
});

test("disabled reviews stay pending without inference and resume when enabled", async () => {
  const { state, store, cfg, review } = operationFixture();
  store.fail(review, "retry", false);
  store.db.query("UPDATE inbox SET available=0 WHERE id=?").run(review.event.id);
  cfg.followupReviews = false;
  let inference = 0;
  const worker = new Worker(store, { request: async () => { inference++; throw new Error("Unexpected inference"); } } as any,
    cfg, state, "fixture", "fixture", () => undefined);
  worker.pump(); await worker.stop();
  expect(inference).toBe(0);
  expect((store.reviews()[0] as any).state).toBe("pending");
  store.receive(event("1500000000000000002"), "public");
  const human = store.claim(Date.now(), false)!;
  expect(human.review).toBeUndefined(); store.complete(human, "silent:done");
  expect(store.claim(Date.now(), false)).toBeUndefined();
  expect(store.claim(Date.now(), true)!.event.id).toBe(review.event.id);
  store.close();
});

test("a stale review report cannot overwrite the newer attempt or claim success", async () => {
  const { store, bridge, operations, review } = operationFixture();
  await operations.call("review-task", "fetch_messages", {});
  const fetch = bridge.fetchAllowedChannel;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  bridge.fetchAllowedChannel = async () => { await gate; return fetch(); };
  const stale = operations.call("review-task", "review_report", { disposition: "resolved", summary: "stale", evidence: [] });
  store.fail(review, "interrupted", false);
  const newer = store.claim(Date.now() + 60000)!;
  expect(newer.lease).not.toBe(review.lease);
  store.db.query("INSERT INTO review_reports VALUES (?,?,?)").run(review.event.id, JSON.stringify({ summary: "newer" }), Date.now());
  release();
  await expect(stale).rejects.toThrow("Lost inbox lease");
  expect(JSON.parse((store.reviews()[0] as any).report).summary).toBe("newer");
  expect(operations.outcome(review.event.id)).toBeUndefined();
  store.close();
});

test("revoked review admission is checked before Codex starts and retains operator evidence", async () => {
  const { state, store, cfg, review, operations } = operationFixture();
  store.fail(review, "retry", false);
  store.db.query("UPDATE inbox SET available=0 WHERE id=?").run(review.event.id);
  cfg.channels[channel].allowUsers = ["another"];
  let requests = 0;
  const worker = new Worker(store, { request: async () => { requests++; throw new Error("Unexpected Codex request"); } } as any,
    cfg, state, "fixture", "fixture", () => undefined, {}, job => operations.validateReview(job));
  worker.pump(); await worker.stop();
  expect(requests).toBe(0);
  expect((store.reviews()[0] as any).state).toBe("blocked");
  expect((store.reviews()[0] as any).error).toContain("no longer admitted");
  store.close();
});
