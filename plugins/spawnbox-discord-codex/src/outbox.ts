import type { Store } from "./store";
export class UncertainDelivery extends Error {}
export class Outbox {
  private active = new Set<string>();
  constructor(private store: Store) {}
  async part(
    operation: string,
    part: number,
    eventId: string,
    channel: string,
    payload: unknown,
    send: (extra: Record<string, unknown>) => Promise<string>,
  ): Promise<string> {
    const key = `${operation}:${part}`;
    if (this.active.has(key))
      throw new Error("Delivery is already in progress");
    this.active.add(key);
    try {
      const row = this.store.prepare(
        operation,
        part,
        eventId,
        channel,
        payload,
      );
      if (row.state === "sent") return row.message_id;
      // Discord nonces only deduplicate recent messages. Unknown outcomes must
      // stay visible after that window instead of silently risking duplicates.
      if (row.state === "sending" && Date.now() - row.started > 60000)
        throw new UncertainDelivery(`Reconcile ${key} before retrying`);
      this.store.sending(operation, part);
      const id = await send({ nonce: row.nonce, enforceNonce: true });
      this.store.sent(operation, part, id);
      return id;
    } finally {
      this.active.delete(key);
    }
  }
}
