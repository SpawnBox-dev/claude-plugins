import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { handleRemember } from "../../mcp/tools/remember";
import type { EmbeddingClient } from "../../mcp/engine/embeddings";
import { now } from "../../mcp/utils";
import { resolveNoteId } from "../../mcp/tools/id_resolver";

// ===========================================================================
// 0.32.0: PRIOR KNOWLEDGE PUSHED AT THE MOMENT OF ASSERTION.
//
// THE GAP THIS CLOSES (found by reading the write path, not by complaint):
// fifteen note types exist; only three - decision, convention, anti_pattern -
// got ANY prior-art surfacing at write time, and those three are checked for
// DUPLICATION, not for relevance. An agent writing an `insight`, an
// `architecture` note, or a `gotcha` saw nothing at all. So the single moment
// where an agent is most committed to a claim - the moment it writes the claim
// down - was also the moment the KB was quietest.
//
// SCOPE, STATED HONESTLY (boundary per note 9a23c918): this covers ONLY the
// class where the correcting knowledge WAS ALREADY IN THE KB and the author
// wrote past it. It does NOT cover the class where a confident external claim
// was never in the KB at all - no amount of retrieval catches that one, and
// pretending otherwise would let a half-fix look like a whole one.
//
// WHY THE FLOOR IS 0.68 AND NOT 0.60 - the load-bearing detail:
// 0.60 was the first choice, and the EXISTING suite rejected it within one
// run. The fc7fcb0d test uses a 0.60 neighbour as its definition of "no
// near-match, no advisory noise" - a judgement about this KB that someone had
// already encoded. Lowering my feature onto that line would have fired on
// notes previously ruled to be noise, and "fix the test to agree with the new
// feature" is the exact anti-pattern this repo keeps re-learning. The floor
// moved to respect the prior ruling; the prior ruling did not move.
//
// These tests pin BOTH directions, because a nudge has two failure modes and
// only one of them is visible in production: firing too little is invisible
// (nothing happens), firing too much trains dismissal (everything happens, and
// agents learn to skim past it). The base-rate half is the half that rots.
// ===========================================================================

function makeDb(type: "project" | "global"): Database {
  const db = new Database(":memory:");
  applyMigrations(db, type);
  return db;
}

describe("0.32.0: prior-knowledge push at write time", () => {
  let projectDb: Database;
  let globalDb: Database;

  beforeEach(() => {
    projectDb = makeDb("project");
    globalDb = makeDb("global");
  });

  // cos([1,0], [x,y]) = x / sqrt(x^2 + y^2). Pick x=sim, y=sqrt(1-sim^2).
  function vec(targetSim: number): Float32Array {
    const x = targetSim;
    const y = Math.sqrt(Math.max(0, 1 - targetSim * targetSim));
    return new Float32Array([x, y]);
  }
  function client(vector: Float32Array): EmbeddingClient {
    return { embed: async (_t: string[]) => [vector] } as unknown as EmbeddingClient;
  }
  function seed(db: Database, noteId: string, vector: Float32Array) {
    db.run(
      `INSERT OR REPLACE INTO embeddings (note_id, vector, model, embedded_at)
       VALUES (?, ?, ?, ?)`,
      [noteId, Buffer.from(vector.buffer), "bge-m3", new Date().toISOString()]
    );
  }
  function prior(db: Database, opts: { id: string; type: string; content: string }) {
    const ts = now();
    db.run(
      `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, status, priority, due_date, created_at, updated_at, source_session)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [opts.id, opts.type, opts.content, null, "", opts.type, "medium", 0, null, null, null, ts, ts, null]
    );
  }

  // --- the gap itself: types that previously got total silence ---------------

  test("an `insight` write surfaces relevant prior art (previously: silence)", async () => {
    prior(projectDb, { id: "a1b2c3d4-1111-4000-8000-000000000001", type: "insight", content: "alpha epsilon theta iota" });
    seed(projectDb, "a1b2c3d4-1111-4000-8000-000000000001", vec(0.8));

    const result = await handleRemember(
      projectDb,
      globalDb,
      { content: "omega kappa sigma lambda", type: "insight" },
      client(new Float32Array([1, 0]))
    );

    // Stored - this is a push, never a block. The author keeps their write.
    expect(result.stored).toBe(true);
    expect(result.blocked_on_resolution).toBeUndefined();
    expect(result.message).toContain("a1b2c3d4");
  });

  test("`architecture` too - the push is not limited to the 3 alert types", async () => {
    prior(projectDb, { id: "b2c3d4e5-2222-4000-8000-000000000002", type: "architecture", content: "alpha epsilon theta iota" });
    seed(projectDb, "b2c3d4e5-2222-4000-8000-000000000002", vec(0.82));

    const result = await handleRemember(
      projectDb,
      globalDb,
      { content: "omega kappa sigma lambda", type: "architecture" },
      client(new Float32Array([1, 0]))
    );

    expect(result.stored).toBe(true);
    expect(result.message).toContain("b2c3d4e5");
  });

  test("the push asks for RECONCILIATION, not acknowledgement", async () => {
    // A nudge that only says "here is a related note" gets skimmed. The text
    // has to name the actions: contradiction, supersession, or context. This
    // pins the intent, not the wording - if someone softens it into a bare
    // listing, the nudge has lost its job.
    prior(projectDb, { id: "c3d4e5f6-3333-4000-8000-000000000003", type: "insight", content: "alpha epsilon theta iota" });
    seed(projectDb, "c3d4e5f6-3333-4000-8000-000000000003", vec(0.9));

    const result = await handleRemember(
      projectDb,
      globalDb,
      { content: "omega kappa sigma lambda", type: "insight" },
      client(new Float32Array([1, 0]))
    );

    const m = result.message.toLowerCase();
    expect(m).toContain("contradict");
    expect(m).toContain("supersede");
  });

  // --- base rate: the half that rots if unguarded ----------------------------

  test("REGRESSION GUARD: a 0.60 neighbour stays silent - the encoded noise line", async () => {
    // This is the exact case that failed when the floor was 0.60. It is the
    // reason the floor is 0.68. Do not lower it to make some other feature
    // fire; that trade was already refused once, on evidence.
    prior(projectDb, { id: "d4e5f6a7-4444-4000-8000-000000000004", type: "insight", content: "alpha epsilon theta iota" });
    seed(projectDb, "d4e5f6a7-4444-4000-8000-000000000004", vec(0.6));

    const result = await handleRemember(
      projectDb,
      globalDb,
      { content: "omega kappa sigma lambda", type: "insight" },
      client(new Float32Array([1, 0]))
    );

    expect(result.stored).toBe(true);
    expect(result.message).not.toContain("d4e5f6a7");
    expect(result.message.toUpperCase()).not.toContain("PRIOR KNOWLEDGE");
  });

  test("an empty KB produces no push at all - no ceremony on a clean write", async () => {
    const result = await handleRemember(
      projectDb,
      globalDb,
      { content: "omega kappa sigma lambda", type: "insight" },
      client(new Float32Array([1, 0]))
    );
    expect(result.stored).toBe(true);
    expect(result.message.toUpperCase()).not.toContain("PRIOR KNOWLEDGE");
  });

  test("the push is CAPPED - a hub topic cannot bury the author in matches", async () => {
    // Vocabulary-dense areas (PA / session / compaction) match broadly. An
    // uncapped list is the same dismissal-training failure as a low floor,
    // arriving by a different route.
    for (let i = 0; i < 8; i++) {
      prior(projectDb, { id: `f${i}a2b3c4-6666-4000-8000-00000000000${i}`, type: "insight", content: "alpha epsilon theta iota" });
      seed(projectDb, `f${i}a2b3c4-6666-4000-8000-00000000000${i}`, vec(0.85));
    }

    const result = await handleRemember(
      projectDb,
      globalDb,
      { content: "omega kappa sigma lambda", type: "insight" },
      client(new Float32Array([1, 0]))
    );

    const shown = (result.message.match(/f\da2b3c4/g) ?? []).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThanOrEqual(3);
  });

  // --- the identifier contract: assert the ROUND-TRIP, not the width ---------

  test("CONTRACT: whatever identifier the push renders, resolveNoteId resolves", async () => {
    // Proposed by PA after we BOTH got this wrong in opposite directions in the
    // same ten minutes. I claimed the rendered id8 was unusable and "fixed" it
    // to a full UUID on the strength of an empty grep against two filenames
    // that do not exist (mcp/tools/supersede_note.ts, mcp/tools/update_note.ts
    // - the real files are supersede.ts and update_note_helpers.ts). PA then
    // generalised my wrong finding into a proposed class-wide sweep. Neither of
    // us had read mcp/tools/id_resolver.ts, which resolves an 8-hex prefix for
    // lookup, supersede, update_note, close_thread and delete_note alike.
    //
    // Asserting "the render is 8 chars" would just re-encode a guess. Asserting
    // the ROUND-TRIP encodes the thing that actually has to be true, and it
    // fails loudly if EITHER the render width or the resolver changes - which
    // is the only version of this test that would have caught either mistake.
    const id = "a1b2c3d4-1111-4000-8000-000000000001";
    prior(projectDb, { id, type: "insight", content: "alpha epsilon theta iota" });
    seed(projectDb, id, vec(0.8));

    const result = await handleRemember(
      projectDb,
      globalDb,
      { content: "omega kappa sigma lambda", type: "insight" },
      client(new Float32Array([1, 0]))
    );

    // Pull the identifier back OUT of the rendered message rather than assuming
    // its shape, then feed it to the resolver the push's own advice depends on.
    const rendered = result.message.match(/^ {2}- (\S+) \[/m)?.[1];
    expect(rendered).toBeTruthy();
    expect(resolveNoteId(projectDb, rendered!).id).toBe(id);
  });

  // --- interaction with the pre-existing duplicate gate ----------------------

  test("does not double-report a note the duplicate advisory already showed", async () => {
    // anti_pattern blocks at 0.85 and advises in [0.75, 0.85). A note surfaced
    // as a consolidation advisory must not ALSO appear under prior knowledge -
    // the same id twice in one message reads as two findings.
    prior(projectDb, { id: "e5f6a7b8-5555-4000-8000-000000000005", type: "anti_pattern", content: "alpha epsilon theta iota" });
    seed(projectDb, "e5f6a7b8-5555-4000-8000-000000000005", vec(0.78));

    const result = await handleRemember(
      projectDb,
      globalDb,
      { content: "omega kappa sigma lambda", type: "anti_pattern" },
      client(new Float32Array([1, 0]))
    );

    expect(result.stored).toBe(true);
    const occurrences = (result.message.match(/e5f6a7b8/g) ?? []).length;
    expect(occurrences).toBe(1);
  });
});
