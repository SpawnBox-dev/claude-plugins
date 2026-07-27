import { Database } from "bun:sqlite";
import { mergeDuplicates } from "./mcp/engine/deduplicator";
const db = new Database(process.env.PDB!);
db.run("PRAGMA busy_timeout = 5000");
const lb = (db.query("SELECT COUNT(*) c FROM links").get() as any).c;
const nb = (db.query("SELECT COUNT(*) c FROM notes").get() as any).c;
const s = performance.now();
let merged = 0, err = "";
try { merged = mergeDuplicates(db); } catch (e) { err = (e as Error).message; }
const ms = performance.now() - s;
const la = (db.query("SELECT COUNT(*) c FROM links").get() as any).c;
const na = (db.query("SELECT COUNT(*) c FROM notes").get() as any).c;
console.log(`elapsed:  ${(ms/1000).toFixed(1)}s`);
console.log(`error:    ${err || "NONE - completed"}`);
console.log(`notes:    ${nb} -> ${na}  (merged ${merged})`);
console.log(`links:    ${lb} -> ${la}  (removed ${lb-la})`);
