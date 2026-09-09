# Discord transport foundation

Vendored from https://github.com/Openclaw-Metis/codex-discord-mcp at
`6d0813bfce26ffedf0a0d090802113fbe57e6754` (source package 0.2.0).
MIT license is preserved in `codex-discord-mcp/LICENSE`.

Only the Discord bridge and its helper dependency graph are imported. The upstream
CLI, MCP gateway owner, JSON queue and Codex exec relay are not entrypoints of this
package. SpawnBox adds an adapter option to the bridge for transactional ingress,
persistent DM recipients, explicitly admitted diagnostic webhooks and durable
chunk receipts. Upstream defaults remain available for its own tests.

The independent SpawnBox service owns the Gateway and app-server connection.
No application command registration is performed. Preserve this file and the
license when updating; record the new immutable revision and rerun adapter tests.
