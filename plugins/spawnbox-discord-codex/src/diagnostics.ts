import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { childEnvironment } from "./app-server";
import type { HelpConfig, Job } from "./types";
import type { Store } from "./store";
const exec = promisify(execFile);
export class Diagnostics {
  constructor(
    private config: HelpConfig,
    private store: Store,
    private state: string,
  ) {}
  private async wrangler(args: string[]) {
    const env = childEnvironment(this.config.codexHome);
    env.CI = "true";
    for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"])
      if (process.env[key]) env[key] = process.env[key];
    const result = await exec(
      "node",
      [
        join(
          this.config.projectRoot,
          "worker/node_modules/wrangler/bin/wrangler.js",
        ),
        ...args,
      ],
      {
        cwd: join(this.config.projectRoot, "worker"),
        env,
        windowsHide: true,
        timeout: 120000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    return result.stdout;
  }
  private async query(sql: string) {
    const value = JSON.parse(
      await this.wrangler([
        "d1",
        "execute",
        "spawnbox-platform",
        "--remote",
        "--command",
        sql,
        "--json",
      ]),
    );
    if (
      !Array.isArray(value) ||
      value.some((result) => result.success === false)
    )
      throw new Error("D1 read failed");
    return value.flatMap((result) => result.results || []);
  }
  async read(job: Job, args: any): Promise<unknown> {
    if (args.action === "versions")
      return {
        versions: await this.query(
          "SELECT version, channel, pub_date FROM update_manifests ORDER BY pub_date DESC LIMIT 10",
        ),
      };
    const id = args.packageId;
    if (
      typeof id !== "string" ||
      !/^diag-(?:[a-f0-9]{8}-[a-f0-9]{3}|\d{10})$/.test(id)
    )
      throw new Error("Invalid diagnostic package ID");
    const audience = this.store.audience(job.conversation);
    if (!["private", "staff"].includes(audience))
      throw new Error(
        "Inspect diagnostic bundles in the participant's private support room or staff context",
      );
    const shared = this.store.db
      .query("SELECT 1 FROM inbox WHERE conversation=? AND payload LIKE ?")
      .get(job.conversation, `%${id}%`);
    if (!shared)
      throw new Error("Diagnostic ID was not shared in this conversation");
    const rows = await this.query(
      `SELECT id,app_version,anonymized,chunk_count,total_bytes,compressed_bytes,screenshots_count,status,uploaded_at,r2_prefix,manifest_json FROM diagnostic_packages WHERE id='${id}'`,
    );
    if (rows.length !== 1) return { found: false };
    const meta = rows[0];
    if (args.action === "metadata") return { found: true, metadata: meta };
    const chunks = Number(meta.chunk_count),
      screenshots = Number(meta.screenshots_count);
    if (
      !Number.isSafeInteger(chunks) ||
      chunks < 1 ||
      chunks > 32 ||
      Number(meta.compressed_bytes) > 64 * 1024 * 1024 ||
      Number(meta.total_bytes) > 256 * 1024 * 1024
    )
      throw new Error("Package exceeds the bounded HELP diagnostic reader");
    const prefix = meta.r2_prefix;
    if (
      typeof prefix !== "string" ||
      !prefix.includes(id) ||
      prefix.includes("..") ||
      !/^[a-zA-Z0-9_./-]+\/$/.test(prefix)
    )
      throw new Error("Unexpected diagnostic storage prefix");
    const dir = join(this.state, "diagnostics", id);
    mkdirSync(dir, { recursive: true });
    if (args.action === "screenshot") {
      if (
        !Number.isInteger(args.index) ||
        args.index < 0 ||
        args.index >= screenshots
      )
        throw new Error("Screenshot index is outside package inventory");
      const path = join(dir, `screenshot_${args.index}.png`);
      await this.wrangler([
        "r2",
        "object",
        "get",
        `spawnbox-archives/${prefix}screenshot_${args.index}.png`,
        "--remote",
        "--file",
        path,
      ]);
      const size = statSync(path).size;
      if (size === 0 || size > 10 * 1024 * 1024)
        throw new Error("Screenshot missing or exceeds 10 MiB");
      return {
        image: {
          data: readFileSync(path).toString("base64"),
          mimeType: "image/png",
        },
        index: args.index,
      };
    }
    const paths: string[] = [];
    let size = 0;
    for (let i = 0; i < chunks; i++) {
      const path = join(dir, `part_${i}.zst`);
      await this.wrangler([
        "r2",
        "object",
        "get",
        `spawnbox-archives/${prefix}part_${i}.zst`,
        "--remote",
        "--file",
        path,
      ]);
      const partSize = statSync(path).size;
      size += partSize;
      if (partSize === 0 || size > 64 * 1024 * 1024)
        throw new Error(
          "Diagnostic chunk missing or compressed data exceeds limit",
        );
      paths.push(path);
    }
    const helper = resolve(import.meta.dir, "../scripts/diag-reader.py");
    const result = await exec(
      "python",
      [
        helper,
        JSON.stringify(paths),
        args.member || "",
        String(args.offset || 0),
      ],
      {
        env: childEnvironment(this.config.codexHome),
        windowsHide: true,
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      },
    );
    return {
      packageId: id,
      screenshotsCount: screenshots,
      ...JSON.parse(result.stdout),
    };
  }
}
