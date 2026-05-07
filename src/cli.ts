#!/usr/bin/env node
import * as p from "@clack/prompts";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { runHardfork, showHelp } from "@/commands/hardfork.ts";
import { runNuke } from "@/commands/nuke.ts";
import { runRevert } from "@/commands/revert.ts";
import type { NukeArgv, ParsedArgv, RevertArgv } from "@/lib/types.ts";
import { exitCancelled } from "@/lib/prompts-util.ts";
import { getVersion } from "@/lib/version.ts";

async function main(): Promise<void> {
  const parsed = yargs(hideBin(process.argv))
    .help(false)
    .version(false)
    .command("nuke [repo]", "Nuke a repo to an empty state", (yy) =>
      yy
        .positional("repo", { type: "string", describe: "Target repo URL (GitHub/GitLab)" })
        .option("preserve-history", { type: "boolean", default: false })
        .option("wipe-history", { type: "boolean", default: false })
        .option("branch", { type: "string", describe: "Branch to nuke (default: main)" })
        .option("all-branches", { type: "boolean", default: false, describe: "Nuke all branches" })
        .option("message", {
          alias: "m",
          type: "string",
          describe: "Commit message for the nuke commit",
        })
        .option("y", { alias: "yes", type: "boolean", default: false }),
    )
    .command("revert [repo] [commit]", "Force-move a branch to a commit", (yy) =>
      yy
        .positional("repo", { type: "string", describe: "Target repo URL (GitHub/GitLab)" })
        .positional("commit", { type: "string", describe: "Commit hash to move the branch to" })
        .option("branch", { type: "string", describe: "Branch to move (default: remote HEAD or main)" })
        .option("keep-history", { type: "boolean", default: false, describe: "Revert via new commit(s) (no rewrite)" })
        .option("destructive", { type: "boolean", default: false, describe: "Hard reset + force-push (rewrites history)" })
        .option("y", { alias: "yes", type: "boolean", default: false }),
    )
    .option("source", { type: "string", description: "Source repository URL" })
    .option("remote", { type: "string", description: "New repository URL (origin)" })
    .option("dir", { type: "string", description: "Local directory for normal clone" })
    .option("branch", { type: "string", description: "Source branch to clone" })
    .option("all-branches", { type: "boolean", description: "Clone and push all source branches", default: false })
    .option("current-branch-only", { type: "boolean", description: "Clone and push one branch only", default: false })
    .option("temp", { type: "boolean", description: "Temporary clone; removed after push", default: false })
    .option("normal", { type: "boolean", description: "Keep local clone", default: false })
    .option("history", { type: "boolean", description: "Keep full git history", default: false })
    .option("no-history", { type: "boolean", description: "Single fresh commit", default: false })
    .option("depth", { type: "number", description: "Keep only the latest n commits of source history" })
    .option("push", { type: "boolean", description: "Push after setting remote", default: false })
    .option("no-push", { type: "boolean", description: "Do not push", default: false })
    .option("y", { alias: "yes", type: "boolean", default: false })
    .option("h", { alias: "help", type: "boolean" })
    .option("v", { alias: "version", type: "boolean" })
    .parseSync();

  const argvAny = parsed as unknown as { _: unknown[]; h?: boolean; v?: boolean };
  if (argvAny.h) {
    showHelp();
    process.exit(0);
  }
  if (argvAny.v) {
    console.log(getVersion());
    process.exit(0);
  }

  const first = String((parsed._[0] ?? "") as string);
  if (first === "nuke") {
    await runNuke(parsed as unknown as NukeArgv);
    return;
  }
  if (first === "revert") {
    await runRevert(parsed as unknown as RevertArgv);
    return;
  }
  await runHardfork(parsed as unknown as ParsedArgv);
}

main().catch((err: unknown) => {
  if (p.isCancel(err)) exitCancelled();
  p.log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
