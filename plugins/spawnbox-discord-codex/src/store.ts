import { Database } from "bun:sqlite";
import { randomUUID, createHash } from "node:crypto";
import type { Inbound, Job } from "./types";

export class Store {
  readonly db: Database;
  constructor(path: string) {
    this.db = new Database(path, { create: true });
    if ((this.db.query("PRAGMA user_version").get() as any).user_version > 2) {
      this.db.close();
      throw new Error("HELP state schema is newer than this runtime");
    }
    this.db
      .exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, conversation TEXT NOT NULL, payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, available INTEGER NOT NULL DEFAULT 0,
        lease TEXT, lease_until INTEGER, error TEXT, outcome TEXT, received INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS inbox_ready ON inbox(state,available,received);
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, thread_id TEXT, audience TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dm_recipients (channel_id TEXT PRIMARY KEY, user_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (operation TEXT NOT NULL, part INTEGER NOT NULL, event_id TEXT NOT NULL,
        channel_id TEXT NOT NULL, payload TEXT NOT NULL, nonce TEXT NOT NULL, state TEXT NOT NULL,
        started INTEGER, message_id TEXT, PRIMARY KEY(operation,part));
      CREATE TABLE IF NOT EXISTS cursors (channel_id TEXT PRIMARY KEY, message_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dynamic_channels (id TEXT PRIMARY KEY, audience TEXT NOT NULL, user_id TEXT, purpose TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (operation TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, timestamp INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS locks (name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS quota_pause (id INTEGER PRIMARY KEY CHECK(id=1), paused INTEGER NOT NULL,
        next_check INTEGER NOT NULL, failures INTEGER NOT NULL, reason TEXT NOT NULL);
      PRAGMA user_version=2;`);
  }
  close() {
    this.db.close();
  }
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }
  lock(name: string, owner: string, now = Date.now(), ttl = 30000): boolean {
    return (
      this.db
        .query(
          `INSERT INTO locks VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires=excluded.expires
      WHERE locks.expires < ? OR locks.owner = excluded.owner`,
        )
        .run(name, owner, now + ttl, now).changes === 1
    );
  }
  unlock(name: string, owner: string) {
    this.db
      .query("DELETE FROM locks WHERE name=? AND owner=?")
      .run(name, owner);
  }
  receive(event: Inbound, audience: string): boolean {
    const conversation = event.isDM
      ? `dm:${event.userId}:${event.channelId}`
      : `guild:${event.guildId}:${event.channelId}`;
    return this.transaction(() => {
      const old = this.db
        .query("SELECT audience FROM conversations WHERE id=?")
        .get(conversation) as { audience: string } | null;
      if (old && old.audience !== audience)
        throw new Error(
          "Conversation audience changed; operator review required before reusing context",
        );
      this.db
        .query("INSERT OR IGNORE INTO conversations(id,audience) VALUES (?,?)")
        .run(conversation, audience);
      if (event.isDM) this.rememberDM(event.channelId, event.userId);
      return (
        this.db
          .query(
            "INSERT OR IGNORE INTO inbox(id,conversation,payload,received) VALUES (?,?,?,?)",
          )
          .run(event.id, conversation, JSON.stringify(event), Date.now())
          .changes === 1
      );
    });
  }
  rememberDM(channel: string, user: string) {
    this.db
      .query(
        "INSERT INTO dm_recipients VALUES (?,?) ON CONFLICT(channel_id) DO UPDATE SET user_id=excluded.user_id",
      )
      .run(channel, user);
  }
  dmChannels(allowedUsers: string[]): string[] {
    const allowed = new Set(allowedUsers);
    return (
      this.db.query("SELECT channel_id,user_id FROM dm_recipients").all() as {
        channel_id: string;
        user_id: string;
      }[]
    )
      .filter((row) => allowed.has(row.user_id))
      .map((row) => row.channel_id);
  }
  dmUser(channel: string): string | undefined {
    return (
      this.db
        .query("SELECT user_id FROM dm_recipients WHERE channel_id=?")
        .get(channel) as any
    )?.user_id;
  }
  recover(now = Date.now()) {
    this.db
      .query(
        "UPDATE inbox SET state='pending',lease=NULL,lease_until=NULL,error='Worker lease expired' WHERE state='running' AND lease_until < ?",
      )
      .run(now);
  }
  claim(now = Date.now()): Job | undefined {
    return this.transaction(() => {
      this.recover(now);
      if (this.quotaPause()) return;
      const row = this.db
        .query(
          `SELECT * FROM inbox i WHERE state='pending' AND available <= ?
        AND NOT EXISTS (SELECT 1 FROM inbox other WHERE other.conversation=i.conversation AND other.state='running')
        AND NOT EXISTS (SELECT 1 FROM inbox older WHERE older.conversation=i.conversation AND older.state IN ('pending','blocked') AND
          (older.received < i.received OR (older.received=i.received AND older.id < i.id)))
        ORDER BY received,id LIMIT 1`,
        )
        .get(now) as any;
      if (!row) return;
      const lease = randomUUID();
      this.db
        .query(
          "UPDATE inbox SET state='running',attempts=attempts+1,lease=?,lease_until=? WHERE id=?",
        )
        .run(lease, now + 60000, row.id);
      return {
        event: JSON.parse(row.payload),
        conversation: row.conversation,
        attempts: row.attempts + 1,
        lease,
      };
    });
  }
  renew(job: Job) {
    this.db
      .query(
        "UPDATE inbox SET lease_until=? WHERE id=? AND lease=? AND state='running'",
      )
      .run(Date.now() + 60000, job.event.id, job.lease);
  }
  complete(job: Job, outcome: string) {
    const result = this.db
      .query(
        "UPDATE inbox SET state='handled',outcome=?,lease=NULL,lease_until=NULL WHERE id=? AND lease=? AND state='running'",
      )
      .run(outcome, job.event.id, job.lease);
    if (!result.changes) throw new Error("Lost inbox lease");
    this.db.query("UPDATE quota_pause SET failures=0 WHERE paused=0").run();
  }
  quotaPause(): { next_check: number; failures: number; reason: string } | undefined {
    return (this.db.query("SELECT next_check,failures,reason FROM quota_pause WHERE id=1 AND paused=1").get() as any) || undefined;
  }
  deferQuota(job: Job, error: unknown, now = Date.now()) {
    this.transaction(() => {
      const previous = this.db.query("SELECT failures FROM quota_pause WHERE id=1").get() as any;
      const failures = (previous?.failures ?? 0) + 1;
      const next = now + Math.min(3600000, 60000 * 2 ** Math.min(failures - 1, 6));
      this.db.query(`INSERT INTO quota_pause VALUES(1,1,?,?,?) ON CONFLICT(id) DO UPDATE SET
        paused=1,next_check=MAX(quota_pause.next_check,excluded.next_check),failures=excluded.failures,reason=excluded.reason`)
        .run(next, failures, String(error).slice(0, 2000));
      const uncertain = this.db.query("SELECT 1 FROM outbox WHERE event_id=? AND state='sending'").get(job.event.id);
      this.db.query(`UPDATE inbox SET state=?,available=0,attempts=MAX(0,attempts-1),error=?,lease=NULL,lease_until=NULL
        WHERE id=? AND lease=? AND state='running'`)
        .run(uncertain ? "blocked" : "pending", String(error).slice(0, 2000), job.event.id, job.lease);
      this.audit("quota_paused", { event: job.event.id, nextCheck: next, uncertain: Boolean(uncertain) });
    });
  }
  scheduleQuotaCheck(next: number, reason: string, failures: number) {
    this.db.query("UPDATE quota_pause SET next_check=?,reason=? WHERE id=1 AND paused=1 AND failures=?").run(next, reason.slice(0,2000), failures);
  }
  resumeQuota(failures: number) {
    const changed = this.db.query("UPDATE quota_pause SET paused=0,next_check=0 WHERE id=1 AND paused=1 AND failures=?").run(failures).changes;
    if (changed) this.audit("quota_resumed", "Native account availability verified; no credit redeemed");
  }
  fail(job: Job, error: unknown, uncertain = false) {
    const blocked = uncertain || job.attempts >= 5;
    this.db
      .query(
        "UPDATE inbox SET state=?,available=?,error=?,lease=NULL,lease_until=NULL WHERE id=? AND lease=?",
      )
      .run(
        blocked ? "blocked" : "pending",
        Date.now() + Math.min(60000, 1000 * 2 ** job.attempts),
        String(error).slice(0, 2000),
        job.event.id,
        job.lease,
      );
    this.audit(blocked ? "attention" : "retry", {
      event: job.event.id,
      error: String(error).slice(0, 1000),
    });
  }
  thread(conversation: string): string | undefined {
    return (
      (
        this.db
          .query("SELECT thread_id FROM conversations WHERE id=?")
          .get(conversation) as any
      )?.thread_id || undefined
    );
  }
  bindThread(conversation: string, id: string) {
    this.db
      .query("UPDATE conversations SET thread_id=? WHERE id=?")
      .run(id, conversation);
  }
  audience(conversation: string): string {
    return (
      this.db
        .query("SELECT audience FROM conversations WHERE id=?")
        .get(conversation) as any
    ).audience;
  }
  active(threadId: string): Job | undefined {
    const row = this.db
      .query(
        "SELECT i.* FROM inbox i JOIN conversations c ON i.conversation=c.id WHERE c.thread_id=? AND i.state='running'",
      )
      .get(threadId) as any;
    return (
      row && {
        event: JSON.parse(row.payload),
        conversation: row.conversation,
        attempts: row.attempts,
        lease: row.lease,
      }
    );
  }
  receipt(operation: string, part: number): any {
    return this.db
      .query("SELECT * FROM outbox WHERE operation=? AND part=?")
      .get(operation, part);
  }
  reserve(operation: string, payload: unknown) {
    const encoded = JSON.stringify(payload);
    this.db
      .query("INSERT OR IGNORE INTO deliveries VALUES (?,?)")
      .run(operation, encoded);
    if (
      (
        this.db
          .query("SELECT payload FROM deliveries WHERE operation=?")
          .get(operation) as any
      ).payload !== encoded
    )
      throw new Error("Operation key reused with different content");
  }
  prepare(
    operation: string,
    part: number,
    eventId: string,
    channel: string,
    payload: unknown,
  ): any {
    const encoded = JSON.stringify(payload);
    const nonce = BigInt(
      "0x" +
        createHash("sha256")
          .update(`${operation}:${part}`)
          .digest("hex")
          .slice(0, 16),
    ).toString();
    this.db
      .query(
        "INSERT OR IGNORE INTO outbox(operation,part,event_id,channel_id,payload,nonce,state) VALUES (?,?,?,?,?,?,'prepared')",
      )
      .run(operation, part, eventId, channel, encoded, nonce);
    const row = this.receipt(operation, part);
    if (
      row.payload !== encoded ||
      row.channel_id !== channel ||
      row.event_id !== eventId
    )
      throw new Error("Operation key reused with different content");
    return row;
  }
  sending(operation: string, part: number) {
    this.db
      .query(
        "UPDATE outbox SET state='sending',started=? WHERE operation=? AND part=? AND state='prepared'",
      )
      .run(Date.now(), operation, part);
  }
  sent(operation: string, part: number, id: string) {
    this.db
      .query(
        "UPDATE outbox SET state='sent',message_id=? WHERE operation=? AND part=?",
      )
      .run(id, operation, part);
  }
  cursor(channel: string): string | undefined {
    return (
      this.db
        .query("SELECT message_id FROM cursors WHERE channel_id=?")
        .get(channel) as any
    )?.message_id;
  }
  advance(channel: string, id: string) {
    const old = this.cursor(channel);
    if (!old || BigInt(id) > BigInt(old))
      this.db
        .query(
          "INSERT INTO cursors VALUES (?,?) ON CONFLICT(channel_id) DO UPDATE SET message_id=excluded.message_id",
        )
        .run(channel, id);
  }
  audit(kind: string, detail: unknown) {
    this.db
      .query("INSERT INTO audit(timestamp,kind,detail) VALUES (?,?,?)")
      .run(Date.now(), kind, JSON.stringify(detail));
  }
  status() {
    return {
      quota: this.quotaPause() ?? null,
      inbox: this.db
        .query("SELECT state,count(*) AS count FROM inbox GROUP BY state")
        .all(),
      uncertain: this.db
        .query(
          "SELECT operation,part,event_id,channel_id,started FROM outbox WHERE state='sending'",
        )
        .all(),
      attention: this.db
        .query(
          "SELECT id,error FROM inbox WHERE state='blocked' ORDER BY received LIMIT 30",
        )
        .all(),
      serviceAttention: this.db
        .query(
          "SELECT timestamp,kind,detail FROM audit WHERE kind IN ('fatal','catchup_attention','ingress_error') ORDER BY id DESC LIMIT 30",
        )
        .all(),
      service: this.db
        .query("SELECT name,expires FROM locks WHERE expires > ?")
        .all(Date.now()),
    };
  }
}
