/** Read existing knowledge without starting MCP, migrations, or fleet processes. */
import { Database } from "bun:sqlite";

const [path, operation, ...args] = process.argv.slice(2);
if (!path || !operation) throw new Error("Usage: bun scripts/kb-read.ts DATABASE schema|search|read QUERY");
const db = new Database(path, { readonly: true });
try {
  if (operation === "schema") {
    console.log(JSON.stringify(db.query("SELECT name, sql FROM sqlite_master WHERE name IN ('notes','notes_fts')").all(), null, 2));
  } else if (operation === "search") {
    const query = args.join(" ");
    console.log(JSON.stringify(db.query("SELECT id, type, substr(content,1,1400) AS content, tags, code_refs FROM notes WHERE superseded_by IS NULL AND (content LIKE ? OR tags LIKE ?) ORDER BY updated_at DESC LIMIT 15").all(`%${query}%`, `%${query}%`), null, 2));
  } else if (operation === "read") {
    console.log(JSON.stringify(db.query("SELECT id, type, content, context, tags, code_refs, source_session, updated_at FROM notes WHERE id LIKE ? LIMIT 8").all(`${args[0]}%`), null, 2));
  } else throw new Error("Unknown operation");
} finally {
  db.close();
}
