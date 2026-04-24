# Orchestrator Design Docs

This directory captures the design intent and architectural decisions behind the orchestrator plugin. Code shows what the plugin does; orchestrator notes (in the plugin's own DB) track ongoing evolution; these docs explain WHY the plugin is shaped the way it is.

The split is deliberate:

- **Code** is authoritative on "what": signatures, schemas, behavior.
- **Orchestrator notes** (inside the running plugin's DB) are authoritative on "what's changing right now": in-flight R-series, open threads, recent decisions, superseded patterns. The whole plugin is the evolution log.
- **These docs** are authoritative on "why the thing exists the way it does": the load-bearing design framework, the architectural shape, and the committed-to-history reasoning behind each R-shipment.

Durable. Version-controlled. Meant to be readable without the running plugin.

## Contents

- [DESIGN-PRINCIPLES.md](./DESIGN-PRINCIPLES.md) - The three-dimension design-intent test (always-up-to-date / more-accurate-over-time / faster-to-traverse), R1-R5 architectural roots, load-bearing constraints, and the deterministic-vs-judgment dividing line that separates plumbing from agent decisions.

- [ARCHITECTURE.md](./ARCHITECTURE.md) - Plugin layout grounded in the actual source: dual-SQLite data model, the ~18 MCP tool surface grouped by verb class, engine components, skills and agents, hook flow, and the retrieval pipelines for lookup / note / briefing.

- [DECISIONS.md](./DECISIONS.md) - Reverse-chronological decision log. Each entry: date, change, rationale, what-was-rejected, where it shipped. Covers the R1 - R4.1 shipments plus the framing decision that named the R-series.

## How to use

- New contributor: read in order. DESIGN-PRINCIPLES first (why), ARCHITECTURE second (how), DECISIONS as reference.
- Changing the tool surface, data model, or retrieval path: re-read DESIGN-PRINCIPLES's R1-R5 and the deterministic-vs-judgment section before proposing, then append an entry to DECISIONS after shipping.
- Debugging unexpected plugin behavior: DECISIONS is often the fastest path to "why does it do that" because it preserves the rejected alternatives inline.
