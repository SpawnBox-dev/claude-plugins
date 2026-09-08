import { ACTIVE_EMBED_DIM, ACTIVE_EMBED_MODEL, ACTIVE_EMBED_MODEL_REPO, type EmbeddingClient } from "../engine/embeddings";

/** A live sidecar with incompatible weights stays available to its existing owner. */
export async function codexSidecarCompatible(client: Pick<EmbeddingClient, "health" | "embed">): Promise<boolean> {
  const health = await client.health();
  if (!health || health.status !== "ready" || ![ACTIVE_EMBED_MODEL, ACTIVE_EMBED_MODEL_REPO].includes(health.model || "") || health.dim !== ACTIVE_EMBED_DIM) return false;
  const vectors = await client.embed(["model check"]);
  return vectors?.[0]?.length === ACTIVE_EMBED_DIM;
}
