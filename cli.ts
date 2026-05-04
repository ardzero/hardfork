#!/usr/bin/env node
import * as p from "@clack/prompts";
import color from "picocolors";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { execa } from "execa";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

const INTRO_TITLE = color.bgCyan(color.black(" hardfork "));

const exitCancelled = (message = "Cancelled"): never => {
  p.cancel(message);
  process.exit(0);
};

function getVersion(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const packageJsonPath = resolve(__dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.1";
  } catch {
    return "0.0.1";
  }
}

function validateSourceUrl(value: string | undefined): string | undefined {
  if (value == null || !value.trim()) return "Repository URL is required";
  const v = value.trim();
  if (
    !/^https:\/\/(github\.com|gitlab\.com)\//i.test(v) &&
    !/^git@(github|gitlab)\.com:/i.test(v)
  ) {
    return "Use a GitHub or GitLab HTTPS or SSH clone URL";
  }
  return undefined;
}

function validateRemoteUrl(value: string | undefined): string | undefined {
  if (value == null || !value.trim()) return "Remote URL is required";
  const v = value.trim();
  if (
    !/^https:\/\/(github\.com|gitlab\.com)\//i.test(v) &&
    !/^git@(github|gitlab)\.com:/i.test(v)
  ) {
    return "Use a GitHub or GitLab HTTPS or SSH URL for the new remote";
  }
  return undefined;
}

function repoSlugFromUrl(url: string): string {
  const stripped = url.trim().replace(/\.git$/i, "");
  const part = stripped.split(/[/:]/).pop()?.replace(/\.git$/i, "") ?? "repo";
  return part || "repo";
}

async function getRemoteHeadBranch(remoteUrl: string): Promise<string | undefined> {
  try {
    const { stdout } = await execa("git", ["ls-remote", "--symref", remoteUrl, "HEAD"], { stdio: "pipe" });
    // Example: "ref: refs/heads/main\tHEAD"
    const m = stdout.match(/ref:\s+refs\/heads\/([^\s]+)\s+HEAD/);
    return m?.[1];
  } catch {
    return undefined;
  }
}

async function listRemoteBranches(remoteUrl: string): Promise<string[]> {
  // returns branch names without refs/heads/
  const { stdout } = await execa("git", ["ls-remote", "--heads", remoteUrl], { stdio: "pipe" });
  const branches = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split("\t")[1] ?? "")
    .filter((ref) => ref.startsWith("refs/heads/"))
    .map((ref) => ref.replace(/^refs\/heads\//, ""))
    .filter(Boolean);
  // de-dupe, stable
  return Array.from(new Set(branches));
}

async function gitBranchShowCurrent(cwd: string): Promise<string> {
  const { stdout } = await execa("git", ["branch", "--show-current"], { cwd });
  const b = stdout.trim();
  if (b) return b;
  const { stdout: sha } = await execa("git", ["rev-parse", "--short", "HEAD"], { cwd });
  throw new Error(`Detached HEAD at ${sha.trim()} — check out a branch before hardfork.`);
}

async function gitDefaultBranchFromRemote(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execa("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
      cwd,
    });
    const line = stdout.trim();
    const m = /^origin\/(.+)$/.exec(line);
    return m?.[1];
  } catch {
    return undefined;
  }
}

async function resolveBranchToPush(cwd: string): Promise<string> {
  const current = await gitBranchShowCurrent(cwd);
  const remoteDefault = await gitDefaultBranchFromRemote(cwd);
  if (remoteDefault && current === remoteDefault) return current;
  return current;
}

/**
 * One fresh root commit with no lineage to the original repo (tree preserved).
 */
async function collapseToSingleCommit(cwd: string): Promise<void> {
  const branch = await gitBranchShowCurrent(cwd);
  await execa("git", ["checkout", "--orphan", "__hardfork_orphan"], { cwd });
  await execa("git", ["add", "-A"], { cwd });
  await execa("git", ["commit", "-m", "Initial commit"], { cwd }).catch(async () => {
    await execa("git", ["checkout", branch], { cwd }).catch(() => {});
    throw new Error("Nothing to commit after orphan checkout — empty repo?");
  });
  await execa("git", ["branch", "-D", branch], { cwd });
  await execa("git", ["branch", "-m", branch], { cwd });
}

async function cloneRepo(url: string, dest: string, withHistory: boolean): Promise<void> {
  const args = ["clone"];
  if (!withHistory) args.push("--depth", "1");
  args.push(url, dest);
  await execa("git", args, { stdio: "pipe" });
}

async function cloneRepoAllBranchesShallow(url: string, dest: string): Promise<void> {
  // For multi-branch operations: fetch branch tips, not full history.
  await execa("git", ["clone", "--no-single-branch", "--depth", "1", url, dest], { stdio: "pipe" });
}

async function setOriginUrl(cwd: string, newUrl: string): Promise<void> {
  await execa("git", ["remote", "set-url", "origin", newUrl], { cwd });
}

async function pushToNewRemote(cwd: string, branch: string): Promise<void> {
  await execa("git", ["push", "-u", "origin", branch], { cwd, stdio: "inherit" });
}

async function pushHeadToBranch(cwd: string, branch: string): Promise<void> {
  await execa("git", ["push", "-u", "origin", `HEAD:${branch}`], { cwd, stdio: "inherit" });
}

async function forcePushHeadToBranch(cwd: string, branch: string): Promise<void> {
  await execa("git", ["push", "--force", "-u", "origin", `HEAD:${branch}`], { cwd, stdio: "inherit" });
}

function removeRepoContentsExceptGit(repoRoot: string): void {
  const entries = readdirSync(repoRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    rmSync(join(repoRoot, entry.name), { recursive: true, force: true });
  }
}

function validateLocalDir(name: string | undefined): string | undefined {
  if (name == null || !name.trim()) return "Directory name is required";
  const baseName = basename(name.trim());
  if (!baseName || baseName === "." || baseName === "..") return "Invalid directory name";
  const target = resolve(process.cwd(), name.trim());
  if (existsSync(target)) return `Path already exists: ${name.trim()}`;
  return undefined;
}

type CloneMode = "temp" | "normal";
type NukeMode = "preserve" | "wipe";

interface ParsedArgv {
  source?: string;
  remote?: string;
  dir?: string;
  temp?: boolean;
  normal?: boolean;
  history?: boolean;
  noHistory?: boolean;
  push?: boolean;
  noPush?: boolean;
  y: boolean;
  h?: boolean;
  v?: boolean;
  _: (string | number)[];
}

interface NukeArgv {
  repo?: string;
  preserveHistory?: boolean;
  wipeHistory?: boolean;
  branch?: string;
  allBranches?: boolean;
  message?: string;
  y: boolean;
  _: (string | number)[];
}

function showHelp(): void {
  console.clear();
  p.intro(INTRO_TITLE);
  console.log(color.bold("\nUsage:"));
  console.log(`  ${color.cyan("hardfork")} ${color.dim("[options]")}`);
  console.log(`  ${color.cyan("hardfork nuke <repoUrl>")} ${color.dim("[options]")}`);
  console.log(`  ${color.cyan("bun run cli.ts")} ${color.dim("[options]")}`);
  p.note(
    `${color.cyan("hardfork")}\n  Interactive: source URL → clone mode → history → remote → push\n\n` +
      `${color.cyan("hardfork --source https://github.com/you/old.git --remote git@github.com:you/new.git -y")}\n  Non-interactive with push\n\n` +
      `${color.cyan("hardfork --source ... --temp --remote ... --no-history -y")}\n  Temp dir, single new root commit, push, delete clone\n\n` +
      `${color.cyan("hardfork nuke https://github.com/you/repo.git")}\n  Make a repo empty (prompt preserve vs wipe history)`,
    "Examples",
  );
  console.log(color.bold("\nOptions:"));
  console.log(`  ${color.cyan("--source <url>")}     Source repo (GitHub/GitLab)`);
  console.log(`  ${color.cyan("--remote <url>")}    Your new empty repo URL (required for --temp)`);
  console.log(`  ${color.cyan("--dir <path>")}      Clone destination (normal mode); default: repo name`);
  console.log(`  ${color.cyan("--temp")}            Clone in a temp folder and delete after push`);
  console.log(`  ${color.cyan("--normal")}           Keep local clone (default)`);
  console.log(`  ${color.cyan("--history")}          Full clone with history (default)`);
  console.log(`  ${color.cyan("--no-history")}       Single new commit (no lineage)`);
  console.log(`  ${color.cyan("--push")}             Push to new remote after wiring`);
  console.log(`  ${color.cyan("--no-push")}          Only set remote URL`);
  console.log(`  ${color.cyan("-y, --yes")}         Skip prompts (needs required flags)`);
  console.log(`  ${color.cyan("-h, --help")}`);
  console.log(`  ${color.cyan("-v, --version")}`);
  p.outro(color.dim("Hard fork: clone → point origin at your repo → push"));
}

async function runHardfork(argv: ParsedArgv): Promise<void> {
  console.clear();
  p.intro(INTRO_TITLE);

  let source =
    argv.source?.trim() ||
    (argv._[0] != null && String(argv._[0]).trim() !== "" ? String(argv._[0]).trim() : undefined);

  if (!source && !argv.y) {
    const t = await p.text({
      message: "Source repository URL (GitHub or GitLab)",
      placeholder: "https://github.com/org/repo.git",
      validate: validateSourceUrl,
    });
    if (p.isCancel(t)) exitCancelled();
    source = t as string;
  }

  if (!source) {
    p.log.error("Source URL is required (--source or positional)");
    process.exit(1);
  }

  const srcErr = validateSourceUrl(source);
  if (srcErr) {
    p.log.error(srcErr);
    process.exit(1);
  }

  let cloneMode: CloneMode = "normal";
  if (argv.temp && argv.normal) {
    p.log.error("Use only one of --temp or --normal");
    process.exit(1);
  }
  if (argv.temp) cloneMode = "temp";
  else if (argv.normal) cloneMode = "normal";
  else if (!argv.y) {
    const mode = await p.select({
      message: "Where should the clone live?",
      options: [
        {
          value: "normal" as const,
          label: "Normal clone",
          hint: "Keep the folder on disk; optional new remote",
        },
        {
          value: "temp" as const,
          label: "Temporary clone",
          hint: "Requires new remote + push; deletes folder after push",
        },
      ],
      initialValue: "normal",
    });
    if (p.isCancel(mode)) exitCancelled();
    cloneMode = mode as CloneMode;
  }

  let withHistory = true;
  if (argv.history && argv.noHistory) {
    p.log.error("Use only one of --history or --no-history");
    process.exit(1);
  }
  if (argv.noHistory) withHistory = false;
  else if (argv.history) withHistory = true;
  else if (!argv.y) {
    const hist = await p.confirm({
      message: "Preserve full commit history from the source?",
      initialValue: true,
    });
    if (p.isCancel(hist)) exitCancelled();
    withHistory = hist as boolean;
  }

  let newRemote = argv.remote?.trim();
  if (cloneMode === "temp") {
    if (!newRemote && !argv.y) {
      const r = await p.text({
        message: "New repository URL (must exist; empty repo recommended)",
        placeholder: "git@github.com:you/fork.git",
        validate: validateRemoteUrl,
      });
      if (p.isCancel(r)) exitCancelled();
      newRemote = (r as string).trim();
    }
    if (!newRemote) {
      p.log.error("Temporary clone requires --remote (your new repo)");
      process.exit(1);
    }
    const remErr = validateRemoteUrl(newRemote);
    if (remErr) {
      p.log.error(remErr);
      process.exit(1);
    }
  } else if (!newRemote && !argv.y) {
    const link = await p.confirm({
      message: "Point origin at a new remote (your fork repo)?",
      initialValue: true,
    });
    if (p.isCancel(link)) exitCancelled();
    if (link) {
      const r = await p.text({
        message: "New remote URL",
        placeholder: "https://github.com/you/fork.git",
        validate: validateRemoteUrl,
      });
      if (p.isCancel(r)) exitCancelled();
      newRemote = (r as string).trim();
    }
  }

  let shouldPush = false;
  if (cloneMode === "temp") shouldPush = true;
  else if (argv.push && argv.noPush) {
    p.log.error("Use only one of --push or --no-push");
    process.exit(1);
  } else if (argv.noPush) shouldPush = false;
  else if (argv.push) shouldPush = true;
  else if (newRemote && !argv.y) {
    const pushAns = await p.confirm({
      message: "Push to the new remote now?",
      initialValue: true,
    });
    if (p.isCancel(pushAns)) exitCancelled();
    shouldPush = pushAns as boolean;
  } else if (newRemote && argv.y) {
    shouldPush = true;
  }

  if (cloneMode === "temp" && !shouldPush) {
    p.log.error("Temporary clone always pushes; fix flags");
    process.exit(1);
  }

  let localPath: string;
  if (cloneMode === "temp") {
    localPath = mkdtempSync(join(tmpdir(), "hardfork-"));
  } else {
    let dirArg = argv.dir?.trim();
    if (!dirArg && argv.y) dirArg = repoSlugFromUrl(source);
    if (!dirArg && !argv.y) {
      const suggested = repoSlugFromUrl(source);
      const d = await p.text({
        message: "Local directory name",
        placeholder: suggested,
        initialValue: suggested,
        validate: validateLocalDir,
      });
      if (p.isCancel(d)) exitCancelled();
      dirArg = (d as string).trim();
    }
    if (!dirArg) {
      p.log.error("Normal clone needs --dir or prompts");
      process.exit(1);
    }
    const dErr = validateLocalDir(dirArg);
    if (dErr) {
      p.log.error(dErr);
      process.exit(1);
    }
    localPath = resolve(process.cwd(), dirArg);
  }

  const s = p.spinner();

  s.start("Cloning repository");
  try {
    await cloneRepo(source, localPath, withHistory);
    s.stop(color.green("Cloned"));
  } catch (e) {
    s.stop(color.red("Clone failed"));
    p.log.error(e instanceof Error ? e.message : String(e));
    if (cloneMode === "temp" && existsSync(localPath)) rmSync(localPath, { recursive: true, force: true });
    process.exit(1);
  }

  try {
    if (!withHistory) {
      s.start("Rewriting as a single new commit");
      await collapseToSingleCommit(localPath);
      s.stop(color.green("History collapsed"));
    }

    if (newRemote) {
      s.start("Pointing origin at new remote");
      await setOriginUrl(localPath, newRemote);
      s.stop(color.green("Remote updated"));
    } else {
      p.log.warn("No new remote — origin still references the source. Add one with:");
      p.log.info(`  cd ${relative(process.cwd(), localPath) || "."}`);
      p.log.info("  git remote set-url origin <your-repo-url>");
    }

    if (shouldPush && newRemote) {
      const branch = await resolveBranchToPush(localPath);
      s.start(`Pushing ${branch} to origin`);
      try {
        await pushToNewRemote(localPath, branch);
        s.stop(color.green("Pushed"));
      } catch (e) {
        s.stop(color.red("Push failed"));
        throw e;
      }
    }
  } catch (e) {
    p.log.error(e instanceof Error ? e.message : String(e));
    if (cloneMode === "temp" && existsSync(localPath)) rmSync(localPath, { recursive: true, force: true });
    process.exit(1);
  }

  if (cloneMode === "temp") {
    s.start("Removing temporary clone");
    rmSync(localPath, { recursive: true, force: true });
    s.stop(color.green("Temporary clone removed"));
    p.note(`${color.cyan(newRemote ?? "")}\nYour repo now has the forked content.`, "Done");
  } else {
    p.note(`cd ${relative(process.cwd(), localPath) || "."}`, "Done");
  }

  p.outro(color.green("hardfork complete"));
}

async function runNuke(argv: NukeArgv): Promise<void> {
  console.clear();
  p.intro(INTRO_TITLE);

  const repo =
    argv.repo?.trim() || (argv._[1] != null && String(argv._[1]).trim() !== "" ? String(argv._[1]).trim() : undefined);

  if (!repo) {
    p.log.error("Repo URL is required (hardfork nuke <repoUrl>)");
    process.exit(1);
  }
  const repoErr = validateRemoteUrl(repo);
  if (repoErr) {
    p.log.error(repoErr);
    process.exit(1);
  }

  const DEFAULT_NUKE_MESSAGE = "Nuke repository";
  let commitMessage: string = argv.message?.trim() ?? "";
  if (!commitMessage && !argv.y) {
    const msg = await p.text({
      message: "Commit message for the nuke commit",
      placeholder: DEFAULT_NUKE_MESSAGE,
      initialValue: DEFAULT_NUKE_MESSAGE,
      validate: (v) => (!v?.trim() ? "Commit message is required" : undefined),
    });
    if (p.isCancel(msg)) exitCancelled();
    commitMessage = (msg as string).trim();
  }
  if (!commitMessage) commitMessage = DEFAULT_NUKE_MESSAGE;

  type NukeScope = "branch" | "all";
  let scope: NukeScope = argv.allBranches ? "all" : "branch";
  if (!argv.allBranches && !argv.branch && !argv.y) {
    const sc = await p.select({
      message: "What should be nuked?",
      options: [
        { value: "branch" as const, label: "A specific branch", hint: "Default: main" },
        { value: "all" as const, label: "All branches", hint: "Overwrites every branch in the remote" },
      ],
      initialValue: "branch",
    });
    if (p.isCancel(sc)) exitCancelled();
    scope = sc as NukeScope;
  }

  let mode: NukeMode = "preserve";
  if (argv.preserveHistory && argv.wipeHistory) {
    p.log.error("Use only one of --preserve-history or --wipe-history");
    process.exit(1);
  }
  if (argv.wipeHistory) mode = "wipe";
  else if (argv.preserveHistory) mode = "preserve";
  else if (!argv.y) {
    const m = await p.select({
      message: "Nuke mode",
      options: [
        {
          value: "preserve" as const,
          label: "Preserve history",
          hint: "Keep all existing commits; just delete files in a new commit",
        },
        {
          value: "wipe" as const,
          label: "Wipe history",
          hint: "Force-push a fresh root commit (rewrites default branch history)",
        },
      ],
      initialValue: "preserve",
    });
    if (p.isCancel(m)) exitCancelled();
    mode = m as NukeMode;
  }

  const defaultBranch = "main";
  let branch: string | undefined = argv.branch?.trim();
  if (scope === "branch") {
    if (!branch && !argv.y) {
      const b = await p.text({
        message: "Branch to nuke",
        placeholder: defaultBranch,
        initialValue: defaultBranch,
        validate: (v) => (!v?.trim() ? "Branch is required" : undefined),
      });
      if (p.isCancel(b)) exitCancelled();
      branch = (b as string).trim();
    }
    if (!branch) branch = defaultBranch;
  }
  const singleBranch = branch ?? defaultBranch;

  // Always show config summary & require confirmation with exact targets.
  const plannedBranchesRaw = scope === "all" ? await listRemoteBranches(repo) : [singleBranch];
  // If the remote has no heads, we still create the requested/default branch.
  const plannedBranches = plannedBranchesRaw.length === 0 ? [singleBranch] : plannedBranchesRaw;

  const shownBranches =
    plannedBranches.length > 25
      ? `${plannedBranches.slice(0, 25).join("\n")}\n... (+${plannedBranches.length - 25} more)`
      : plannedBranches.join("\n");

  const summaryTitle = mode === "wipe" ? "Confirm nuke (danger)" : "Confirm nuke";
  const warningLine = mode === "wipe" ? `${color.bold("This is NOT reversible.")}\n` : "";
  const modeLabel = mode === "wipe" ? "wipe history (force-push)" : "preserve history";

  p.note(
    `${warningLine}` +
      `Mode: ${color.cyan(modeLabel)}\n` +
      `Repo: ${color.cyan(repo)}\n` +
      `Commit: ${color.cyan(commitMessage)}\n` +
      `Branches (${plannedBranches.length}):\n${shownBranches}`,
    summaryTitle,
  );

  if (!argv.y) {
    const ok = await p.confirm({
      message:
        mode === "wipe"
          ? "Proceed with force-push on the branches above?"
          : "Proceed with nuking the branches above?",
      initialValue: mode !== "wipe",
    });
    if (p.isCancel(ok) || !ok) exitCancelled("Nuke aborted");
  }

  const cwd = mkdtempSync(join(tmpdir(), "hardfork-nuke-"));
  const s = p.spinner();

  try {
    if (mode === "preserve") {
      s.start(scope === "all" ? "Cloning target repo (all branches, temp)" : "Cloning target repo (temp)");
      if (scope === "all") {
        await cloneRepoAllBranchesShallow(repo, cwd);
      } else {
        await cloneRepo(repo, cwd, false);
      }
      s.stop(color.green("Cloned"));

      const branches: string[] = scope === "all" ? await listRemoteBranches(repo) : [singleBranch];
      if (branches.length === 0) {
        throw new Error("No branches found on remote.");
      }

      for (const b of branches) {
        s.start(`Nuking branch ${b} (preserve history)`);
        // ensure local branch tracks origin/<b>
        await execa("git", ["fetch", "origin", b, "--depth", "1"], { cwd, stdio: "pipe" });
        await execa("git", ["checkout", "-B", b, `origin/${b}`], { cwd, stdio: "pipe" });
        removeRepoContentsExceptGit(cwd);
        await execa("git", ["add", "-A"], { cwd, stdio: "pipe" });
        await execa("git", ["commit", "--allow-empty", "-m", commitMessage], { cwd, stdio: "pipe" });
        await pushHeadToBranch(cwd, b);
        s.stop(color.green(`Nuked ${b}`));
      }
    } else {
      s.start("Initializing empty repo (temp)");
      await execa("git", ["init"], { cwd });
      await execa("git", ["remote", "add", "origin", repo], { cwd });
      // create one empty commit to force-push everywhere
      await execa("git", ["checkout", "-B", defaultBranch], { cwd });
      await execa("git", ["commit", "--allow-empty", "-m", commitMessage], { cwd });
      s.stop(color.green("Initialized"));

      const branches = plannedBranches;

      if (branches.length === 0) {
        // if repo truly empty (no heads), still create the requested/default branch
        const b = singleBranch;
        s.start(`Force-pushing fresh history to ${b}`);
        await forcePushHeadToBranch(cwd, b);
        s.stop(color.green("Pushed"));
      } else {
        for (const b of branches) {
          s.start(`Force-pushing fresh history to ${b}`);
          await forcePushHeadToBranch(cwd, b);
          s.stop(color.green(`Pushed ${b}`));
        }
      }
    }
  } catch (e) {
    s.stop(color.red("Nuke failed"));
    p.log.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }

  const scopeLabel = scope === "all" ? "all branches" : `branch: ${branch ?? defaultBranch}`;
  p.note(`${color.cyan(repo)}\nTarget: ${color.cyan(scopeLabel)}\nMode: ${color.cyan(mode)}`, "Done");
  p.outro(color.green("nuke complete"));
}

async function main(): Promise<void> {
  const parsed = yargs(hideBin(process.argv))
    .help(false)
    .version(false)
    .command("nuke <repo>", "Nuke a repo to an empty state", (yy) =>
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
    .option("source", { type: "string", description: "Source repository URL" })
    .option("remote", { type: "string", description: "New repository URL (origin)" })
    .option("dir", { type: "string", description: "Local directory for normal clone" })
    .option("temp", { type: "boolean", description: "Temporary clone; removed after push", default: false })
    .option("normal", { type: "boolean", description: "Keep local clone", default: false })
    .option("history", { type: "boolean", description: "Keep full git history", default: false })
    .option("no-history", { type: "boolean", description: "Single fresh commit", default: false })
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
  await runHardfork(parsed as unknown as ParsedArgv);
}

main().catch((err: unknown) => {
  if (p.isCancel(err)) exitCancelled();
  p.log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
