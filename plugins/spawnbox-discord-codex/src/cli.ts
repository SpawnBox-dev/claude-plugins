import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  openSync,
  closeSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "./config";
import { Store } from "./store";
import { startService } from "./service";
import { setupWorker } from "./setup";

const [command, ...args] = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
};
const state = resolve(
  option("state") || join(homedir(), ".codex", "spawnbox-help"),
);
const configPath = resolve(option("config") || join(state, "config.json"));
if (command === "retry" || command === "reconcile") {
  const store = new Store(join(state, "help.db"));
  try {
    if (command === "retry") {
      const id = option("event");
      if (!id) throw new Error("--event is required");
      if (
        store.db
          .query("SELECT 1 FROM outbox WHERE event_id=? AND state='sending'")
          .get(id)
      )
        throw new Error(
          "Reconcile uncertain deliveries before retrying this event",
        );
      const changed = store.db
        .query(
          "UPDATE inbox SET state='pending',available=0,attempts=0,error=NULL,outcome=CASE WHEN outcome LIKE 'operator:%' THEN NULL ELSE outcome END WHERE id=? AND state='blocked'",
        )
        .run(id).changes;
      if (!changed) throw new Error("Event is not blocked");
      store.audit("operator_retry", { event: id });
    } else {
      const operation = option("operation"),
        part = Number(option("part"));
      if (!operation || !Number.isSafeInteger(part) || part < 0)
        throw new Error("--operation and --part are required");
      const receipt = store.receipt(operation, part);
      if (receipt?.state !== "sending")
        throw new Error("Delivery is not uncertain");
      const message = option("message-id");
      if (message && /^\d{15,22}$/.test(message)) {
        store.sent(operation, part, message);
        store.audit("operator_reconciliation", {
          operation,
          part,
          messageId: message,
          evidence: "Operator supplied verified Discord ID",
        });
      } else if (args.includes("--confirmed-not-delivered")) {
        store.db
          .query(
            "UPDATE outbox SET state='prepared',started=NULL WHERE operation=? AND part=?",
          )
          .run(operation, part);
        store.audit("operator_reconciliation", {
          operation,
          part,
          evidence: "Operator confirmed Discord did not accept this operation",
        });
      } else
        throw new Error(
          "Supply a verified --message-id or explicitly --confirmed-not-delivered after checking Discord",
        );
    }
    console.log("Local recovery state updated; no Discord message sent.");
  } finally {
    store.close();
  }
} else if (command === "stop") {
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "stop.request"), new Date().toISOString());
  console.log(
    "Graceful stop requested. The service closes Discord and Codex before releasing its lock.",
  );
} else if (command === "supervise") {
  mkdirSync(state, { recursive: true });
  if (existsSync(join(state, "stop.request")))
    throw new Error(
      "A stop request exists. Remove it locally before explicitly restarting supervision.",
    );
  let failures = 0;
  while (!existsSync(join(state, "stop.request"))) {
    const log = openSync(join(state, "service.log"), "a");
    const started = Date.now();
    const child = spawn(process.execPath, [process.argv[1], "start", ...args], {
      windowsHide: true,
      stdio: ["ignore", log, log],
    });
    writeFileSync(
      join(state, "supervisor.json"),
      JSON.stringify({
        supervisorPid: process.pid,
        childPid: child.pid,
        started,
      }),
    );
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    closeSync(log);
    if (existsSync(join(state, "stop.request"))) break;
    failures = Date.now() - started > 300000 ? 0 : failures + 1;
    await Bun.sleep(Math.min(60000, 1000 * 2 ** Math.min(failures, 6)));
  }
} else if (command === "status") {
  if (!existsSync(join(state, "help.db")))
    console.log(
      JSON.stringify({ configured: existsSync(configPath), started: false }),
    );
  else {
    const store = new Store(join(state, "help.db"));
    try {
      console.log(JSON.stringify(store.status(), null, 2));
    } finally {
      store.close();
    }
  }
} else if (command === "setup") {
  const config = loadConfig(configPath);
  const root = resolve(option("plugin-root") || join(import.meta.dir, ".."));
  await setupWorker(config, root, option("auth-home"));
  console.log(
    "Dedicated Codex HELP worker configured; no Discord connection started.",
  );
} else if (command === "start") {
  const config = loadConfig(configPath);
  // The service deliberately has no fallback to DISCORD_BOT_TOKEN (app bot).
  let token = process.env.DISCORD_HELP_BOT_TOKEN;
  const secretsPath = option("help-settings");
  if (secretsPath) {
    const selected =
      JSON.parse(readFileSync(resolve(secretsPath), "utf8")).env || {};
    token = token || selected.DISCORD_HELP_BOT_TOKEN;
    for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"])
      if (!process.env[key] && typeof selected[key] === "string")
        process.env[key] = selected[key];
  }
  if (!token)
    throw new Error(
      "Set DISCORD_HELP_BOT_TOKEN or pass --help-settings for the local HELP credential. Production app token is never used.",
    );
  delete process.env.DISCORD_HELP_BOT_TOKEN;
  const service = await startService(config, state, token);
  let requested = false;
  const stop = async () => {
    requested = true;
    await service.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const poll = setInterval(() => {
    if (existsSync(join(state, "stop.request"))) void stop();
  }, 1000);
  service.closed.then(() => {
    clearInterval(poll);
    process.exit(requested ? 0 : 1);
  });
  console.log("HELP service running. Ctrl+C stops this listener.");
} else {
  console.log(
    "Usage: bun dist/cli.js setup|start|supervise|stop|status --state <directory> [--config <file>]\nsetup: --plugin-root <installed plugin> [--auth-home <operator Codex home>]\nstart: --help-settings <local settings file> OR DISCORD_HELP_BOT_TOKEN environment",
  );
  if (command) process.exitCode = 1;
}
