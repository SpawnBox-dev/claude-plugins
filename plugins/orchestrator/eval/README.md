# Retrieval evaluation harness

Iterate on search quality **offline**, against the live knowledge base, without
building the plugin or asking anyone to run `/plugin update`. A change only
ships after it wins here.

This exists because on 2026-08-08 semantic search was found to be effectively
non-functional, several "obviously correct" fixes measured *worse*, and the
only thing that separated real improvements from plausible ones was a
benchmark.

## Run it

```bash
cd plugins/orchestrator
bun run eval/make-span-probes.ts     # regenerate probe set A (deterministic)
bun run eval/run.ts span             # variant comparison on set A
bun run eval/run.ts para             # variant comparison on set B
bun run eval/sweep.ts para           # pooling / blend weight sweep
bun run eval/final.ts                # decide a config against BOTH sets
bun run eval/model-ab.ts             # compare two models (needs a 2nd sidecar)
bun run eval/ctx-chunks.ts           # contextualized-chunk A/B on a subset
```

Environment overrides: `ORCHESTRATOR_EVAL_DB`, `ORCHESTRATOR_EVAL_PORT_FILE`,
`ORCHESTRATOR_EVAL_ALT_PORT_FILE` (second model for `model-ab`).

To run a second model side by side:

```bash
uvx --with-requirements sidecar/requirements.txt python sidecar/embed_server.py \
  --port 0 --port-file /tmp/alt.port --model BAAI/bge-base-en-v1.5
```

## The two probe sets, and why both are mandatory

**`probes-span.json` — 192 held-out spans (generated).** Query is a verbatim
~30-word span from the middle of a note; the target is that note. Lexically
easy by construction. It answers *does retrieval work at all* and catches
regressions.

**`probes-para.json` — hand-written paraphrases.** Query states a note's idea
in deliberately different words. Paraphrase matching is the **only** thing
embeddings buy over BM25, so this is the set that decides.

**A change must be non-negative on spans AND positive on paraphrases.** This is
not bureaucracy - it caught a real one. A three-signal blend adding the
whole-note vector won the paraphrase set outright (median rank 42 -> 16) and
regressed span retrieval 77.1% -> 68.8% R@6. Optimising on the semantic metric
alone would have shipped that and reported it as a large win.

## Rules that make the numbers mean something

1. **Probes must never be written into the knowledge base.** An earlier probe
   set was quoted in notes and commit messages; the notes discussing the probes
   became near-exact matches and the benchmark began answering itself. Keep
   probe text in this directory only. Never paste a probe query into a note.

2. **Small sets cannot resolve small differences.** With 19 paraphrase probes,
   one probe is 5.3% of recall@6 - so R@6 gaps under ~10 points are noise.
   Median rank and recall@20 are more granular and move more honestly. Grow the
   paraphrase set before trusting a close call.

3. **Subset runs compare only to each other.** `ctx-chunks.ts` and
   `model-ab.ts` score an 800-note subset, so their absolute numbers are much
   higher than full-corpus ones. Never compare a subset number to a
   full-corpus number.

4. **Record what LOST.** A rejected idea is as valuable as a shipped one and
   costs the next person a day if it is not written down.

## Results log

| date | change | span R@6 | para R@6 | para R@20 | verdict |
|---|---|---|---|---|---|
| 2026-08-08 | whole-note vectors, bge-m3 | - | - | - | baseline, effectively broken |
| 2026-08-08 | passage chunking | 77.6% | 26.3% | 31.6% | SHIPPED 0.46.0 |
| 2026-08-08 | bge-m3 -> bge-small | - | - | - | SHIPPED 0.47.0 |
| 2026-08-08 | mean-centering (anisotropy fix) | - | worse | worse | **REJECTED** - every rank worse |
| 2026-08-08 | BGE query instruction | 77.1% | 26.3% | 36.8% | kept (with blend) |
| 2026-08-08 | pooling 0.6 max + 0.4 mean | 78.1% | 31.6% | 42.1% | SHIPPED 0.50.0 |
| 2026-08-08 | three-signal blend (+ noteVec) | 68.8% | (best) | (best) | **REJECTED** - span regression |
| 2026-08-08 | mean-only pooling | 66.7% | - | - | **REJECTED** |
| 2026-08-08 | bare `query: ` prefix | - | worse | worse | **REJECTED** |
| 2026-08-08 | contextualized chunks (type+headline header) | 84.9%* | 52.6%* | 84.2%* | **REJECTED** - lost both sets |
| 2026-08-08 | bge-small -> bge-base | 92.7%* | 73.7%* | 89.5%* | SHIPPED 0.51.0 |

`*` subset run (800 notes) - compare only against the other arm of the same run.

## Known open direction

See work item `27d1da01`. The fusion layer still suppresses pure-semantic hits
structurally (RRF gives dual-list notes two score contributions; the signal
boost is an absorbing state). The 0.49.0 semantic reserve rescues only the top
two. A reranker over the top ~50 is the untested direction with the most
headroom, and it needs a cross-encoder endpoint the sidecar does not yet have.
