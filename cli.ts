#!/usr/bin/env node
import * as p from "@clack/prompts";
import color from "picocolors";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { execa } from "execa";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

const INTRO_TITLE = color.bgCyan(color.black(" hardfork "));
const INTRO_TITLE_NUKE = color.bgRed(color.black(" hardfork nuke "));
const INTRO_TITLE_REVERT = color.bgYellow(color.black(" hardfork revert "));

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

type SourceRepo = {
  cloneUrl: string;
  branch?: string;
  host?: "github" | "gitlab";
  owner?: string;
  repo?: string;
};

function parseSourceRepo(input: string): SourceRepo {
  const source = input.trim();
  try {
    const url = new URL(source);
    const parts = url.pathname.split("/").filter(Boolean);
    const treeIndex = parts.indexOf("tree");
    const gitlabTreeIndex = parts.findIndex((part, idx) => part === "tree" && parts[idx - 1] === "-");

    if ((url.hostname === "github.com" || url.hostname === "gitlab.com") && parts.length >= 2) {
      const owner = parts[0];
      const repo = parts[1]?.replace(/\.git$/i, "");
      const branchStart = treeIndex >= 2 ? treeIndex + 1 : gitlabTreeIndex >= 3 ? gitlabTreeIndex + 1 : -1;
      const branch = branchStart > 0 ? parts.slice(branchStart).join("/") : undefined;
      return {
        cloneUrl: `${url.protocol}//${url.hostname}/${owner}/${repo}.git`,
        branch,
        host: url.hostname === "github.com" ? "github" : "gitlab",
        owner,
        repo,
      };
    }
  } catch {
    // SSH URLs and plain clone URLs are already acceptable git inputs.
  }
  return { cloneUrl: source };
}

type RepoPreflight = {
  branchCount: number;
  sizeKb?: number;
  commitCount?: number;
  source?: string;
};

async function getRepoSizeKb(source: SourceRepo): Promise<{ sizeKb?: number; source?: string }> {
  if (!source.owner || !source.repo) return {};
  try {
    if (source.host === "github") {
      const res = await fetch(`https://api.github.com/repos/${source.owner}/${source.repo}`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "hardfork-cli" },
      });
      if (!res.ok) return {};
      const data = (await res.json()) as { size?: unknown };
      return typeof data.size === "number" ? { sizeKb: data.size, source: "GitHub" } : {};
    }
    if (source.host === "gitlab") {
      const project = encodeURIComponent(`${source.owner}/${source.repo}`);
      const res = await fetch(`https://gitlab.com/api/v4/projects/${project}`, {
        headers: { "User-Agent": "hardfork-cli" },
      });
      if (!res.ok) return {};
      const data = (await res.json()) as { statistics?: { repository_size?: unknown } };
      const bytes = data.statistics?.repository_size;
      return typeof bytes === "number" ? { sizeKb: Math.round(bytes / 1024), source: "GitLab" } : {};
    }
  } catch {
    return {};
  }
  return {};
}

function parseLastPageFromLinkHeader(link: string | null): number | undefined {
  if (!link) return undefined;
  const last = link
    .split(",")
    .map((part) => part.trim())
    .find((part) => part.includes('rel="last"'));
  const match = last?.match(/[?&]page=(\d+)/);
  return match ? Number(match[1]) : undefined;
}

async function getRepoCommitCount(source: SourceRepo, branch?: string): Promise<{ commitCount?: number }> {
  if (!source.owner || !source.repo) return {};
  try {
    if (source.host === "github") {
      const url = new URL(`https://api.github.com/repos/${source.owner}/${source.repo}/commits`);
      url.searchParams.set("per_page", "1");
      if (branch) url.searchParams.set("sha", branch);
      const res = await fetch(url, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "hardfork-cli" },
      });
      if (!res.ok) return {};
      return { commitCount: parseLastPageFromLinkHeader(res.headers.get("link")) };
    }
    if (source.host === "gitlab") {
      const project = encodeURIComponent(`${source.owner}/${source.repo}`);
      const url = new URL(`https://gitlab.com/api/v4/projects/${project}/repository/commits`);
      url.searchParams.set("per_page", "1");
      if (branch) url.searchParams.set("ref_name", branch);
      const res = await fetch(url, { headers: { "User-Agent": "hardfork-cli" } });
      if (!res.ok) return {};
      const total = Number(res.headers.get("x-total"));
      return Number.isFinite(total) && total > 0 ? { commitCount: total } : {};
    }
  } catch {
    return {};
  }
  return {};
}

function formatSizeKb(sizeKb: number): string {
  if (sizeKb >= 1024 * 1024) return `${(sizeKb / 1024 / 1024).toFixed(1)} GB`;
  if (sizeKb >= 1024) return `${(sizeKb / 1024).toFixed(1)} MB`;
  return `${sizeKb} KB`;
}

function allBranchesLooksExpensive(preflight: RepoPreflight): boolean {
  const sizeKb = preflight.sizeKb ?? 0;
  return preflight.branchCount > 20 || sizeKb > 500 * 1024;
}

function fullHistoryLooksExpensive(preflight: RepoPreflight): boolean {
  const sizeKb = preflight.sizeKb ?? 0;
  const commitCount = preflight.commitCount ?? 0;
  return commitCount > 3000 || sizeKb > 500 * 1024;
}

function parseCommitDepth(value: string | number | undefined): number | undefined {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function estimateTransferSizeKb(params: {
  preflight: RepoPreflight;
  withHistory: boolean;
  historyDepth?: number;
  branchScope: BranchScope;
  selectedBranchCount?: number;
}): number | undefined {
  const { preflight, withHistory, historyDepth, branchScope, selectedBranchCount } = params;
  if (!preflight.sizeKb) return undefined;
  if (!withHistory) return Math.max(1, Math.round(preflight.sizeKb * 0.05));
  if (!historyDepth || !preflight.commitCount) return preflight.sizeKb;

  const historyRatio = Math.min(1, historyDepth / preflight.commitCount);
  const branchRatio =
    branchScope === "all"
      ? 1
      : Math.max(0.2, (branchScope === "specific" ? selectedBranchCount || 1 : 1) / Math.max(1, preflight.branchCount || 1));
  return Math.max(1, Math.round(preflight.sizeKb * historyRatio * branchRatio));
}

function describeHistoryChoice(withHistory: boolean, historyDepth?: number): string {
  if (!withHistory) return "single fresh commit";
  if (historyDepth) return `latest ${historyDepth.toLocaleString()} commits`;
  return "full history";
}

function branchOptions(sourceBranches: string[], sourceBranch?: string): { value: string; label: string }[] {
  const ordered = sourceBranch
    ? [sourceBranch, ...sourceBranches.filter((branch) => branch !== sourceBranch)]
    : sourceBranches;
  return ordered.map((branch) => ({ value: branch, label: branch }));
}

function validateCommitHash(value: string | undefined): string | undefined {
  if (value == null || !value.trim()) return "Commit hash is required";
  const v = value.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(v)) return "Commit hash must be 7-40 hex characters";
  return undefined;
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

function preferredDefaultBranch(branches: string[], fallback: string): string {
  if (branches.includes("main")) return "main";
  if (branches.includes("master")) return "master";
  if (branches.includes(fallback)) return fallback;
  return branches[0] ?? fallback;
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
    await execa("git", ["checkout", branch], { cwd }).catch(() => { });
    throw new Error("Nothing to commit after orphan checkout — empty repo?");
  });
  await execa("git", ["branch", "-D", branch], { cwd });
  await execa("git", ["branch", "-m", branch], { cwd });
}

async function cloneRepo(
  url: string,
  dest: string,
  withHistory: boolean,
  branch: string | undefined,
  allBranches: boolean,
  depth?: number,
): Promise<void> {
  const args = ["clone"];
  args.push("--no-tags");
  if (allBranches) {
    args.push("--no-single-branch");
  } else {
    args.push("--single-branch");
    if (branch) args.push("--branch", branch);
  }
  if (depth) args.push("--depth", String(depth));
  else if (!withHistory) args.push("--depth", "1");
  args.push(url, dest);
  await execa("git", args, { stdio: "pipe" });
}

async function fetchSpecificBranches(cwd: string, branches: string[], depth?: number): Promise<void> {
  for (const branch of branches) {
    const args = ["fetch", "origin"];
    if (depth) args.push("--depth", String(depth));
    args.push(`refs/heads/${branch}:refs/remotes/origin/${branch}`);
    await execa("git", args, { cwd, stdio: "pipe" });
  }
}

async function cloneRepoAllBranchesShallow(url: string, dest: string): Promise<void> {
  // For multi-branch operations: fetch branch tips, not full history.
  await execa("git", ["clone", "--no-single-branch", "--depth", "1", url, dest], { stdio: "pipe" });
}

async function cloneRepoAllBranches(url: string, dest: string): Promise<void> {
  await execa("git", ["clone", "--no-single-branch", url, dest], { stdio: "pipe" });
}

async function setOriginUrl(cwd: string, newUrl: string): Promise<void> {
  await execa("git", ["remote", "set-url", "origin", newUrl], { cwd });
}

async function pushToNewRemote(cwd: string, branch: string): Promise<void> {
  await execa("git", ["push", "-u", "origin", branch], { cwd, stdio: "inherit" });
}

type ExecaLikeError = {
  shortMessage?: string;
  message?: string;
  stderr?: string;
  stdout?: string;
  all?: string;
};

function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const e = err as ExecaLikeError;
    return [e.shortMessage, e.message, e.stderr, e.stdout, e.all].filter(Boolean).join("\n");
  }
  return String(err);
}

function isNonFastForwardPushError(err: unknown): boolean {
  const msg = errorText(err);
  return (
    msg.includes("non-fast-forward") ||
    msg.includes("fetch first") ||
    msg.includes("[rejected]") ||
    msg.includes("failed to push some refs")
  );
}

async function pushToNewRemoteCapture(cwd: string, branch: string): Promise<void> {
  // Capture stderr so we can detect non-fast-forward reliably.
  const res = await execa("git", ["push", "-u", "origin", branch], { cwd, stdio: "pipe", all: true });
  if (res.all?.trim()) {
    // Preserve git's helpful output without breaking our error parsing.
    process.stdout.write(`${res.all}\n`);
  }
}

async function listClonedSourceBranches(cwd: string): Promise<string[]> {
  const { stdout } = await execa("git", ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"], {
    cwd,
    stdio: "pipe",
  });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((ref) => ref !== "origin/HEAD")
    .map((ref) => ref.replace(/^origin\//, ""))
    .filter(Boolean);
}

async function pushClonedSourceBranches(cwd: string, branches: string[]): Promise<void> {
  for (const branch of branches) {
    await execa("git", ["push", "-u", "origin", `refs/remotes/origin/${branch}:refs/heads/${branch}`], {
      cwd,
      stdio: "inherit",
    });
  }
}

async function exportHeadTreeToDir(repoCwd: string, outDir: string): Promise<void> {
  // Export HEAD working tree without .git, preserving file modes.
  const tarPath = join(outDir, "__hardfork_head.tar");
  await execa("git", ["archive", "-o", tarPath, "HEAD"], { cwd: repoCwd, stdio: "pipe" });
  await execa("tar", ["-xf", tarPath, "-C", outDir], { cwd: repoCwd, stdio: "pipe" });
  rmSync(tarPath, { force: true });
}

async function exportCommitTreeToDir(repoCwd: string, commitSha: string, outDir: string): Promise<void> {
  const tarPath = join(outDir, "__hardfork_commit.tar");
  await execa("git", ["archive", "-o", tarPath, commitSha], { cwd: repoCwd, stdio: "pipe" });
  await execa("tar", ["-xf", tarPath, "-C", outDir], { cwd: repoCwd, stdio: "pipe" });
  rmSync(tarPath, { force: true });
}

async function preserveRemoteHistoryButReplaceFiles(params: {
  repoCwd: string;
  branch: string;
  commitMessage: string;
}): Promise<void> {
  const { repoCwd, branch, commitMessage } = params;
  const snapshotDir = mkdtempSync(join(tmpdir(), "hardfork-snapshot-"));
  try {
    await exportHeadTreeToDir(repoCwd, snapshotDir);

    // Move to remote branch tip, then replace files with snapshot, commit, push.
    await execa("git", ["fetch", "origin", branch], { cwd: repoCwd, stdio: "pipe" });
    await execa("git", ["checkout", "-B", branch, `origin/${branch}`], { cwd: repoCwd, stdio: "pipe" });
    removeRepoContentsExceptGit(repoCwd);
    cpSync(snapshotDir, repoCwd, { recursive: true });
    await execa("git", ["add", "-A"], { cwd: repoCwd, stdio: "pipe" });
    await execa("git", ["commit", "-m", commitMessage], { cwd: repoCwd, stdio: "pipe" });
    await pushToNewRemote(repoCwd, branch);
  } finally {
    rmSync(snapshotDir, { recursive: true, force: true });
  }
}

async function replaySourceHistoryOntoRemoteBranch(params: {
  repoCwd: string;
  branch: string;
  sourceTip: string;
  cleanupMessage: string;
}): Promise<void> {
  const { repoCwd, branch, sourceTip, cleanupMessage } = params;

  // Snapshot source commit chain before switching branch.
  const { stdout: revListOut } = await execa("git", ["rev-list", "--reverse", sourceTip], { cwd: repoCwd, stdio: "pipe" });
  const sourceCommits = revListOut
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (sourceCommits.length === 0) {
    throw new Error("Could not read source commit history to replay.");
  }

  // Move to remote branch tip and keep destination history as base.
  await execa("git", ["fetch", "origin", branch], { cwd: repoCwd, stdio: "pipe" });
  await execa("git", ["checkout", "-B", branch, `origin/${branch}`], { cwd: repoCwd, stdio: "pipe" });

  // Separation point: destination commits remain below this cleanup commit.
  removeRepoContentsExceptGit(repoCwd);
  await execa("git", ["add", "-A"], { cwd: repoCwd, stdio: "pipe" });
  await execa("git", ["commit", "--allow-empty", "-m", cleanupMessage], { cwd: repoCwd, stdio: "pipe" });

  // Replay source snapshots as a linear chain on top.
  for (const sha of sourceCommits) {
    const { stdout: subject } = await execa("git", ["show", "-s", "--format=%s", sha], { cwd: repoCwd, stdio: "pipe" });
    const { stdout: originalDate } = await execa("git", ["show", "-s", "--format=%ad", "--date=iso-strict", sha], {
      cwd: repoCwd,
      stdio: "pipe",
    });

    removeRepoContentsExceptGit(repoCwd);
    await exportCommitTreeToDir(repoCwd, sha, repoCwd);

    await execa("git", ["add", "-A"], { cwd: repoCwd, stdio: "pipe" });
    const replayTitle = `${subject.trim()} / [orig ${originalDate.trim()}]`;
    await execa("git", ["commit", "--allow-empty", "-m", `${replayTitle}\n\nsource-commit: ${sha}`], {
      cwd: repoCwd,
      stdio: "pipe",
    });
  }

  await pushToNewRemote(repoCwd, branch);
}

async function pushHeadToBranch(cwd: string, branch: string): Promise<void> {
  await execa("git", ["push", "-u", "origin", `HEAD:${branch}`], { cwd, stdio: "inherit" });
}

async function forcePushHeadToBranch(cwd: string, branch: string): Promise<void> {
  await execa("git", ["push", "--force", "-u", "origin", `HEAD:${branch}`], { cwd, stdio: "inherit" });
}

async function deleteRemoteBranch(cwd: string, branch: string): Promise<void> {
  await execa("git", ["push", "origin", "--delete", branch], { cwd, stdio: "pipe" });
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
type BranchScope = "current" | "specific" | "all";
type NukeMode = "preserve" | "wipe";

interface ParsedArgv {
  source?: string;
  remote?: string;
  dir?: string;
  branch?: string;
  temp?: boolean;
  normal?: boolean;
  history?: boolean;
  noHistory?: boolean;
  depth?: number;
  allBranches?: boolean;
  currentBranchOnly?: boolean;
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

interface RevertArgv {
  repo?: string;
  commit?: string;
  branch?: string;
  keepHistory?: boolean;
  destructive?: boolean;
  y: boolean;
  _: (string | number)[];
}

function showHelp(): void {
  console.clear();
  p.intro(INTRO_TITLE);
  console.log(color.bold("\nUsage:"));
  console.log(`  ${color.cyan("hardfork")} ${color.dim("[options]")}`);
  console.log(`  ${color.cyan("hardfork nuke [repoUrl]")} ${color.dim("[options]")}`);
  console.log(`  ${color.cyan("hardfork revert [repoUrl] [commit]")} ${color.dim("[options]")}`);
  console.log(`  ${color.cyan("bun run cli.ts")} ${color.dim("[options]")}`);
  p.note(
    `${color.cyan("hardfork")}\n  Interactive: source URL → clone mode → history → remote → push\n\n` +
    `${color.cyan("hardfork --source https://github.com/you/old.git --remote git@github.com:you/new.git -y")}\n  Non-interactive with push\n\n` +
    `${color.cyan("hardfork --source ... --temp --remote ... --no-history -y")}\n  Temp dir, single new root commit, push, delete clone\n\n` +
    `${color.cyan("hardfork nuke https://github.com/you/repo.git")}\n  Make a repo empty (prompt preserve vs wipe history)\n\n` +
    `${color.cyan("hardfork revert https://github.com/you/repo.git <commit>")}\n  Move a branch back to a commit (force-push)`,
    "Examples",
  );
  console.log(color.bold("\nOptions:"));
  console.log(`  ${color.cyan("--source <url>")}     Source repo (GitHub/GitLab)`);
  console.log(`  ${color.cyan("--remote <url>")}    Your new empty repo URL (required for --temp)`);
  console.log(`  ${color.cyan("--dir <path>")}      Clone destination (normal mode); default: repo name`);
  console.log(`  ${color.cyan("--branch <name>")}   Source branch to clone; inferred from /tree/<branch> URLs`);
  console.log(`  ${color.cyan("--all-branches")}    Clone and push all source branches (history mode only)`);
  console.log(`  ${color.cyan("--current-branch-only")} Fast path: clone and push one branch only`);
  console.log(`  ${color.cyan("--temp")}            Clone in a temp folder and delete after push`);
  console.log(`  ${color.cyan("--normal")}           Keep local clone (default)`);
  console.log(`  ${color.cyan("--history")}          Full clone with history (default)`);
  console.log(`  ${color.cyan("--no-history")}       Single new commit (no lineage)`);
  console.log(`  ${color.cyan("--depth <n>")}        Keep only the latest n commits of source history`);
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
  const sourceRepo = parseSourceRepo(source);
  const sourceCloneUrl = sourceRepo.cloneUrl;
  const sourceBranch = argv.branch?.trim() || sourceRepo.branch;
  const sourceBranches = await listRemoteBranches(sourceCloneUrl).catch(() => []);
  const repoSize = await getRepoSizeKb(sourceRepo);
  const commitCount = await getRepoCommitCount(sourceRepo, sourceBranch);
  const preflight: RepoPreflight = {
    branchCount: sourceBranches.length,
    ...repoSize,
    ...commitCount,
  };

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
  let historyDepth = parseCommitDepth(argv.depth);
  if (argv.depth != null && !historyDepth) {
    p.log.error("--depth must be a positive integer");
    process.exit(1);
  }
  if (argv.history && argv.noHistory) {
    p.log.error("Use only one of --history or --no-history");
    process.exit(1);
  }
  if (argv.noHistory && historyDepth) {
    p.log.error("Use only one of --no-history or --depth");
    process.exit(1);
  }
  if (argv.noHistory) withHistory = false;
  else if (argv.history || historyDepth) withHistory = true;
  else if (!argv.y) {
    const hist = await p.confirm({
      message: "Preserve full commit history from the source?",
      initialValue: true,
    });
    if (p.isCancel(hist)) exitCancelled();
    withHistory = hist as boolean;
  }

  if (withHistory && fullHistoryLooksExpensive(preflight)) {
    const detail = [
      preflight.commitCount ? `Commits: ${color.cyan(preflight.commitCount.toLocaleString())}` : undefined,
      preflight.sizeKb ? `Size: ${color.cyan(formatSizeKb(preflight.sizeKb))}` : undefined,
      preflight.branchCount ? `Branches: ${color.cyan(String(preflight.branchCount))}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");

    if (argv.y || argv.history) {
      p.log.warn("This repo looks large; preserving full history can take a long time.");
      if (detail) p.log.info(detail);
    } else {
      p.note(
        `${detail || "This repo has a large reported history/size."}\n\n` +
          `You can keep full history, keep only recent commits, or use a single fresh commit.`,
        "Large commit history",
      );
      const historyRoute = await p.select({
        message: "How much source history should be kept?",
        options: [
          { value: "fast" as const, label: "Fast route", hint: "No source commit lineage; one fresh commit" },
          { value: "limited" as const, label: "Limited history", hint: "Keep only the latest N commits" },
          { value: "history" as const, label: "Preserve full history", hint: "Can take a long time" },
        ],
        initialValue: "limited",
      });
      if (p.isCancel(historyRoute)) exitCancelled();
      if (historyRoute === "fast") {
        withHistory = false;
      } else if (historyRoute === "limited") {
        const defaultDepth = preflight.commitCount ? Math.min(1000, preflight.commitCount) : 1000;
        const depth = await p.text({
          message: "How many recent commits should be kept?",
          placeholder: String(defaultDepth),
          initialValue: String(defaultDepth),
          validate: (value) => (parseCommitDepth(value) ? undefined : "Enter a positive integer"),
        });
        if (p.isCancel(depth)) exitCancelled();
        historyDepth = parseCommitDepth(depth as string);
        withHistory = true;
      } else {
        withHistory = true;
      }
    }
  }

  let branchScope: BranchScope = "current";
  let selectedBranches: string[] = sourceBranch ? [sourceBranch] : [];
  if (argv.allBranches && argv.currentBranchOnly) {
    p.log.error("Use only one of --all-branches or --current-branch-only");
    process.exit(1);
  }
  if (argv.allBranches && !withHistory) {
    p.log.error("--all-branches requires history; --no-history creates one new root commit for one branch.");
    process.exit(1);
  }
  if (argv.allBranches) branchScope = "all";
  else if (argv.currentBranchOnly) branchScope = "current";
  else if (withHistory && !argv.y && sourceBranches.length > 1) {
    const looksExpensive = allBranchesLooksExpensive(preflight);
    const sizeLabel = preflight.sizeKb ? `${formatSizeKb(preflight.sizeKb)} ${preflight.source ?? "reported"} repo` : "unknown repo size";
    const scope = await p.select({
      message: "Which branches should be included?",
      options: [
        {
          value: "current" as const,
          label: sourceBranch ? `Fast: only ${sourceBranch}` : "Fast: only the default branch",
          hint: "Recommended; one branch, no tags",
        },
        {
          value: "specific" as const,
          label: "Pick specific branches",
          hint: "Choose one or more branches",
        },
        {
          value: "all" as const,
          label: `All branches (${sourceBranches.length})`,
          hint: looksExpensive ? `Likely slow: ${sizeLabel}` : `Reasonable: ${sizeLabel}`,
        },
      ],
      initialValue: "current",
    });
    if (p.isCancel(scope)) exitCancelled();
    branchScope = scope as BranchScope;
    if (branchScope === "specific") {
      const pickedBranches = await p.multiselect({
        message: "Which branches should be included?",
        options: branchOptions(sourceBranches, sourceBranch),
        initialValues: selectedBranches.length ? selectedBranches : sourceBranch ? [sourceBranch] : [],
        required: true,
      });
      if (p.isCancel(pickedBranches)) exitCancelled();
      selectedBranches = pickedBranches as string[];
    }

    while (branchScope === "all" && looksExpensive) {
      p.note(
        `This repo looks expensive to hard fork with every branch.\n` +
          `Branches: ${color.cyan(String(preflight.branchCount))}\n` +
          `Size: ${color.cyan(preflight.sizeKb ? formatSizeKb(preflight.sizeKb) : "unknown")}\n\n` +
          `Fast route keeps only ${color.cyan(sourceBranch ?? "the default branch")} and skips tags.`,
        "Large all-branches clone",
      );
      const route = await p.select({
        message: "Continue with all branches, use the fast route, or reconfigure?",
        options: [
          { value: "current" as const, label: "Use fast route", hint: "One branch only" },
          { value: "reconfigure" as const, label: "Reconfigure", hint: "Change commit depth and branch choice" },
          { value: "all" as const, label: "Continue with all branches", hint: "Can take a long time" },
        ],
        initialValue: "reconfigure",
      });
      if (p.isCancel(route)) exitCancelled();
      if (route === "current") {
        branchScope = "current";
      } else if (route === "all") {
        break;
      } else {
        const historyRoute = await p.select({
          message: "How much source history should be kept?",
          options: [
            { value: "fast" as const, label: "Fast route", hint: "No source commit lineage; one fresh commit" },
            { value: "limited" as const, label: "Limited history", hint: "Keep only the latest N commits" },
            { value: "history" as const, label: "Preserve full history", hint: "Can take a long time" },
          ],
          initialValue: historyDepth ? "limited" : withHistory ? "history" : "fast",
        });
        if (p.isCancel(historyRoute)) exitCancelled();
        if (historyRoute === "fast") {
          withHistory = false;
          historyDepth = undefined;
          branchScope = "current";
          break;
        }
        if (historyRoute === "limited") {
          const defaultDepth = historyDepth ?? (preflight.commitCount ? Math.min(1000, preflight.commitCount) : 1000);
          const depth = await p.text({
            message: "How many recent commits should be kept?",
            placeholder: String(defaultDepth),
            initialValue: String(defaultDepth),
            validate: (value) => (parseCommitDepth(value) ? undefined : "Enter a positive integer"),
          });
          if (p.isCancel(depth)) exitCancelled();
          historyDepth = parseCommitDepth(depth as string);
          withHistory = true;
        } else {
          historyDepth = undefined;
          withHistory = true;
        }

        const nextScope = await p.select({
          message: "Which branches should be included?",
          options: [
            {
              value: "current" as const,
              label: sourceBranch ? `Fast: only ${sourceBranch}` : "Fast: only the default branch",
              hint: "Recommended; one branch, no tags",
            },
            {
              value: "specific" as const,
              label: "Pick specific branches",
              hint: "Choose one or more branches",
            },
            {
              value: "all" as const,
              label: `All branches (${sourceBranches.length})`,
              hint: `Likely slow: ${sizeLabel}`,
            },
          ],
          initialValue: "current",
        });
        if (p.isCancel(nextScope)) exitCancelled();
        branchScope = nextScope as BranchScope;
        if (branchScope === "specific") {
          const pickedBranches = await p.multiselect({
            message: "Which branches should be included?",
            options: branchOptions(sourceBranches, sourceBranch),
            initialValues: selectedBranches.length ? selectedBranches : sourceBranch ? [sourceBranch] : [],
            required: true,
          });
          if (p.isCancel(pickedBranches)) exitCancelled();
          selectedBranches = pickedBranches as string[];
        }
      }
    }
  }

  while (true) {
    const estimatedSizeKb = estimateTransferSizeKb({
      preflight,
      withHistory,
      historyDepth,
      branchScope,
      selectedBranchCount: selectedBranches.length,
    });
    const branchLabel =
      branchScope === "all"
        ? `all branches (${sourceBranches.length || preflight.branchCount || "unknown"})`
        : branchScope === "specific"
          ? selectedBranches.join(", ")
        : sourceBranch || "default branch";
    const estimateLines = [
      `History: ${color.cyan(describeHistoryChoice(withHistory, historyDepth))}`,
      `Branches: ${color.cyan(branchLabel)}`,
      estimatedSizeKb ? `Estimated clone/push data: ${color.cyan(formatSizeKb(estimatedSizeKb))}` : undefined,
      preflight.sizeKb ? `Reported full repo size: ${color.dim(formatSizeKb(preflight.sizeKb))}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");
    if (estimateLines) {
      if (argv.y) {
        p.log.info(estimateLines);
        break;
      }
      p.note(
        `${estimateLines}\n\n${color.dim("Estimate is rough; Git object sharing, compression, and large blobs can change it.")}`,
        "Estimated transfer",
      );
    }

    const next = await p.select({
      message: "Continue with this setup?",
      options: [
        { value: "continue" as const, label: "Continue", hint: "Enter the new repo URL next" },
        { value: "reconfigure" as const, label: "Reconfigure", hint: "Change history amount or branches" },
      ],
      initialValue: "continue",
    });
    if (p.isCancel(next)) exitCancelled();
    if (next === "continue") break;

    const reconfigure = await p.multiselect({
      message: "What do you want to reconfigure?",
      options: [
        { value: "history" as const, label: "History amount", hint: describeHistoryChoice(withHistory, historyDepth) },
        {
          value: "branches" as const,
          label: "Branches",
          hint:
            branchScope === "all"
              ? `all branches (${sourceBranches.length})`
              : branchScope === "specific"
                ? selectedBranches.join(", ")
                : sourceBranch || "default branch",
        },
      ],
      initialValues: ["history"],
      required: true,
    });
    if (p.isCancel(reconfigure)) exitCancelled();
    const reconfigureChoices = reconfigure as string[];

    if (reconfigureChoices.includes("history")) {
      const historyRoute = await p.select({
        message: "How much source history should be kept?",
        options: [
          { value: "fast" as const, label: "Fast route", hint: "No source commit lineage; one fresh commit" },
          { value: "limited" as const, label: "Limited history", hint: "Keep only the latest N commits" },
          { value: "history" as const, label: "Preserve full history", hint: "Can take a long time" },
        ],
        initialValue: historyDepth ? "limited" : withHistory ? "history" : "fast",
      });
      if (p.isCancel(historyRoute)) exitCancelled();
      if (historyRoute === "fast") {
        withHistory = false;
        historyDepth = undefined;
        branchScope = "current";
        selectedBranches = sourceBranch ? [sourceBranch] : [];
      } else if (historyRoute === "limited") {
        const defaultDepth = historyDepth ?? (preflight.commitCount ? Math.min(1000, preflight.commitCount) : 1000);
        const depth = await p.text({
          message: "How many recent commits should be kept?",
          placeholder: String(defaultDepth),
          initialValue: String(defaultDepth),
          validate: (value) => (parseCommitDepth(value) ? undefined : "Enter a positive integer"),
        });
        if (p.isCancel(depth)) exitCancelled();
        historyDepth = parseCommitDepth(depth as string);
        withHistory = true;
      } else {
        historyDepth = undefined;
        withHistory = true;
      }
    }

    if (reconfigureChoices.includes("branches") && sourceBranches.length > 1 && withHistory) {
      const nextScope = await p.select({
        message: "Which branches should be included?",
        options: [
          {
            value: "current" as const,
            label: sourceBranch ? `Fast: only ${sourceBranch}` : "Fast: only the default branch",
            hint: "Recommended; one branch, no tags",
          },
          {
            value: "specific" as const,
            label: "Pick specific branches",
            hint: "Choose one or more branches",
          },
          {
            value: "all" as const,
            label: `All branches (${sourceBranches.length})`,
            hint: "Can take a long time",
          },
        ],
        initialValue: branchScope,
      });
      if (p.isCancel(nextScope)) exitCancelled();
      branchScope = nextScope as BranchScope;
      if (branchScope === "specific") {
        const pickedBranches = await p.multiselect({
          message: "Which branches should be included?",
          options: branchOptions(sourceBranches, sourceBranch),
          initialValues: selectedBranches.length ? selectedBranches : sourceBranch ? [sourceBranch] : [],
          required: true,
        });
        if (p.isCancel(pickedBranches)) exitCancelled();
        selectedBranches = pickedBranches as string[];
      } else {
        selectedBranches = sourceBranch ? [sourceBranch] : [];
      }
    }
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
    if (!dirArg && argv.y) dirArg = repoSlugFromUrl(sourceCloneUrl);
    if (!dirArg && !argv.y) {
      const suggested = repoSlugFromUrl(sourceCloneUrl);
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

  const depthLabel = historyDepth ? ` latest ${historyDepth.toLocaleString()} commits` : "";
  const cloneBranch = branchScope === "specific" ? selectedBranches[0] : sourceBranch;
  s.start(
    branchScope === "all"
      ? `Cloning all branches${depthLabel}`
      : branchScope === "specific"
        ? `Cloning ${selectedBranches.length} selected branch${selectedBranches.length === 1 ? "" : "es"}${depthLabel}`
      : cloneBranch
        ? `Cloning ${cloneBranch}${depthLabel}`
        : `Cloning repository${depthLabel}`,
  );
  try {
    await cloneRepo(sourceCloneUrl, localPath, withHistory, cloneBranch, branchScope === "all", historyDepth);
    if (branchScope === "specific" && selectedBranches.length > 1) {
      await fetchSpecificBranches(localPath, selectedBranches.slice(1), historyDepth);
    }
    s.stop(color.green("Cloned"));
  } catch (e) {
    s.stop(color.red("Clone failed"));
    p.log.error(e instanceof Error ? e.message : String(e));
    if (cloneMode === "temp" && existsSync(localPath)) rmSync(localPath, { recursive: true, force: true });
    process.exit(1);
  }
  const clonedSourceBranches =
    branchScope === "all" ? await listClonedSourceBranches(localPath) : branchScope === "specific" ? selectedBranches : [];

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

    if (shouldPush && newRemote && (branchScope === "all" || branchScope === "specific")) {
      s.start(`Pushing ${clonedSourceBranches.length} branches to origin`);
      await pushClonedSourceBranches(localPath, clonedSourceBranches);
      s.stop(color.green("Pushed branches"));
    } else if (shouldPush && newRemote) {
      const branch = await resolveBranchToPush(localPath);
      let targetBranch = branch;
      s.start(`Pushing ${targetBranch} to origin`);
      try {
        await pushToNewRemoteCapture(localPath, targetBranch);
        s.stop(color.green("Pushed"));
      } catch (e) {
        s.stop(color.red("Push failed"));
        if (!isNonFastForwardPushError(e)) {
          throw e;
        }

        const remoteBranches = await listRemoteBranches(newRemote).catch(() => []);
        let handledByNukeAll = false;
        if (remoteBranches.length > 1 && !argv.y) {
          const initialBranch = preferredDefaultBranch(remoteBranches, targetBranch);
          const picked = await p.select({
            message: "Destination has multiple branches. Which branch should we update?",
            options: [
              ...remoteBranches.map((b) => ({ value: b, label: b })),
              {
                value: "__nuke_all__",
                label: "Nuke all branches and push to new main/master",
                hint: "Force-push selected primary branch and delete all other branches",
              },
            ],
            initialValue: initialBranch,
          });
          if (p.isCancel(picked)) exitCancelled();
          if (picked === "__nuke_all__") {
            const primaryDefault = preferredDefaultBranch(
              remoteBranches.filter((b) => b === "main" || b === "master"),
              "main",
            );
            const primaryPicked = await p.select({
              message: "Primary branch for the new push",
              options: [
                { value: "main", label: "main" },
                { value: "master", label: "master" },
              ],
              initialValue: primaryDefault === "master" ? "master" : "main",
            });
            if (p.isCancel(primaryPicked)) exitCancelled();
            const primaryBranch = primaryPicked as "main" | "master";
            const branchesToDelete = remoteBranches.filter((b) => b !== primaryBranch);

            p.note(
              `${color.bold("This is NOT reversible.")}\n` +
              `Remote: ${color.cyan(newRemote)}\n` +
              `Primary branch: ${color.cyan(primaryBranch)}\n` +
              `Delete branches (${branchesToDelete.length}): ${color.cyan(branchesToDelete.join(", ") || "(none)")}\n` +
              `Action: ${color.cyan("force-push primary branch + delete all others")}`,
              "Confirm nuke all branches",
            );
            const ok = await p.confirm({
              message: "Proceed with nuking all branches on destination?",
              initialValue: false,
            });
            if (p.isCancel(ok) || !ok) exitCancelled("Nuke-all aborted");

            s.start(`Force-pushing ${primaryBranch} and deleting other branches`);
            await forcePushHeadToBranch(localPath, primaryBranch);
            for (const b of branchesToDelete) {
              try {
                await deleteRemoteBranch(localPath, b);
              } catch {
                p.log.warn(`Could not delete remote branch: ${b}`);
              }
            }
            s.stop(color.green("Nuked destination branches"));
            handledByNukeAll = true;
          }
          if (!handledByNukeAll) {
            targetBranch = picked as string;
          }
        } else if (remoteBranches.length > 0) {
          targetBranch = preferredDefaultBranch(remoteBranches, targetBranch);
        }

        if (!handledByNukeAll && argv.y) {
          p.log.error("Remote rejected the push (non-fast-forward).");
          p.log.info("Rerun without -y so you can choose how to resolve it:");
          p.log.info(" - Force overwrite remote history");
          p.log.info(" - Preserve remote history and replace files in a new commit");
          throw e;
        }

        if (!handledByNukeAll) {
          const resolution = await p.select({
            message: "Remote is not empty. How do you want to proceed?",
            options: [
              {
                value: "preserve" as const,
                label: "Preserve remote history",
                hint: "Keep existing commits; replace files via a new commit, then push",
              },
              {
                value: "force" as const,
                label: "Force overwrite (wipe remote history)",
                hint: "Force-push your branch; remote commits will be lost",
              },
            ],
            initialValue: "preserve",
          });
          if (p.isCancel(resolution)) exitCancelled();

          if (resolution === "force") {
            p.note(
              `${color.bold("This is NOT reversible.")}\n` +
              `Remote: ${color.cyan(newRemote)}\n` +
              `Branch: ${color.cyan(targetBranch)}\n` +
              `Action: ${color.cyan("force-push overwrite")}`,
              "Confirm force overwrite",
            );
            const ok = await p.confirm({
              message: "Proceed with force-pushing and overwriting remote history?",
              initialValue: false,
            });
            if (p.isCancel(ok) || !ok) exitCancelled("Push aborted");

            s.start(`Force-pushing ${targetBranch} to origin`);
            await forcePushHeadToBranch(localPath, targetBranch);
            s.stop(color.green("Force-pushed"));
          } else {
            const preserveMode = await p.select({
              message: "How should we preserve history?",
              options: [
                {
                  value: "single-commit" as const,
                  label: "Single commit on top of remote",
                  hint: "Current behavior: keep remote history, apply forked files as one commit",
                },
                {
                  value: "replay-source-history" as const,
                  label: "Replay source history after cleanup",
                  hint: "Destination commits stay below; then cleanup; then source commits on top",
                },
              ],
              initialValue: "replay-source-history",
            });
            if (p.isCancel(preserveMode)) exitCancelled();

            if (preserveMode === "single-commit") {
              const defaultPreserveCommitMessage = `Hardfork: replaced with files from ${source}`;
              const msg = await p.text({
                message: "Commit message (on top of the remote history)",
                placeholder: defaultPreserveCommitMessage,
                initialValue: defaultPreserveCommitMessage,
                validate: (v) => (!v?.trim() ? "Commit message is required" : undefined),
              });
              if (p.isCancel(msg)) exitCancelled();

              s.start(`Preserving remote history on ${targetBranch}`);
              await preserveRemoteHistoryButReplaceFiles({
                repoCwd: localPath,
                branch: targetBranch,
                commitMessage: (msg as string).trim(),
              });
              s.stop(color.green("Pushed (history preserved via single commit)"));
            } else {
              const cleanupMsg = await p.text({
                message: "Cleanup commit message (separates destination history)",
                placeholder: "Hardfork: cleanup before replaying source history",
                initialValue: "Hardfork: cleanup before replaying source history",
                validate: (v) => (!v?.trim() ? "Cleanup commit message is required" : undefined),
              });
              if (p.isCancel(cleanupMsg)) exitCancelled();

              const { stdout: sourceTip } = await execa("git", ["rev-parse", "HEAD"], {
                cwd: localPath,
                stdio: "pipe",
              });

              s.start(`Replaying source history on top of ${targetBranch}`);
              await replaySourceHistoryOntoRemoteBranch({
                repoCwd: localPath,
                branch: targetBranch,
                sourceTip: sourceTip.trim(),
                cleanupMessage: (cleanupMsg as string).trim(),
              });
              s.stop(color.green("Pushed (source history replayed)"));
            }
          }
        }
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
  p.intro(INTRO_TITLE_NUKE);

  let repo =
    argv.repo?.trim() || (argv._[1] != null && String(argv._[1]).trim() !== "" ? String(argv._[1]).trim() : undefined);

  if (!repo && argv.y) {
    p.log.error("Repo URL is required (hardfork nuke <repoUrl> or interactive prompts)");
    process.exit(1);
  }
  if (!repo) {
    const t = await p.text({
      message: "Repository URL to nuke (GitHub or GitLab)",
      placeholder: "https://github.com/org/repo.git",
      validate: validateRemoteUrl,
    });
    if (p.isCancel(t)) exitCancelled();
    repo = (t as string).trim();
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
        await cloneRepo(repo, cwd, false, undefined, false);
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

async function runRevert(argv: RevertArgv): Promise<void> {
  console.clear();
  p.intro(INTRO_TITLE_REVERT);

  let repo =
    argv.repo?.trim() || (argv._[1] != null && String(argv._[1]).trim() !== "" ? String(argv._[1]).trim() : undefined);
  let commit =
    argv.commit?.trim() ||
    (argv._[2] != null && String(argv._[2]).trim() !== "" ? String(argv._[2]).trim() : undefined);

  if ((!repo || !commit) && argv.y) {
    p.log.error("Repo URL and commit hash are required (hardfork revert <repoUrl> <commit>)");
    process.exit(1);
  }
  if (!repo) {
    const t = await p.text({
      message: "Repository URL (GitHub or GitLab)",
      placeholder: "https://github.com/org/repo.git",
      validate: validateRemoteUrl,
    });
    if (p.isCancel(t)) exitCancelled();
    repo = (t as string).trim();
  }
  const repoErr = validateRemoteUrl(repo);
  if (repoErr) {
    p.log.error(repoErr);
    process.exit(1);
  }

  if (!commit) {
    const h = await p.text({
      message: "Commit hash to revert to",
      placeholder: "abc1234…",
      validate: validateCommitHash,
    });
    if (p.isCancel(h)) exitCancelled();
    commit = (h as string).trim();
  }
  const commitErr = validateCommitHash(commit);
  if (commitErr) {
    p.log.error(commitErr);
    process.exit(1);
  }

  const defaultBranch = (await getRemoteHeadBranch(repo)) || "main";
  let branch = argv.branch?.trim();
  if (!branch && !argv.y) {
    const b = await p.text({
      message: "Branch to revert",
      placeholder: defaultBranch,
      initialValue: defaultBranch,
      validate: (v) => (!v?.trim() ? "Branch is required" : undefined),
    });
    if (p.isCancel(b)) exitCancelled();
    branch = (b as string).trim();
  }
  if (!branch) branch = defaultBranch;

  type RevertMode = "keep-history" | "destructive";
  let mode: RevertMode = "destructive";
  if (argv.keepHistory && argv.destructive) {
    p.log.error("Use only one of --keep-history or --destructive");
    process.exit(1);
  }
  if (argv.keepHistory) mode = "keep-history";
  else if (argv.destructive) mode = "destructive";
  else if (!argv.y) {
    const m = await p.select({
      message: "Revert mode",
      options: [
        {
          value: "keep-history" as const,
          label: "Keep history (non-destructive)",
          hint: "Creates new revert commit(s); does not rewrite history",
        },
        {
          value: "destructive" as const,
          label: "Destructive revert",
          hint: "Hard-resets to the commit and force-pushes (rewrites history)",
        },
      ],
      initialValue: "keep-history",
    });
    if (p.isCancel(m)) exitCancelled();
    mode = m as RevertMode;
  }

  const warningLine = mode === "destructive" ? `${color.bold("This is NOT reversible.")}\n` : "";
  const actionLabel =
    mode === "destructive"
      ? "hard reset + force-push branch to commit"
      : "revert commits after target (new commit(s))";

  p.note(
    `${warningLine}` +
    `Action: ${color.cyan(actionLabel)}\n` +
    `Repo: ${color.cyan(repo)}\n` +
    `Branch: ${color.cyan(branch)}\n` +
    `Commit: ${color.cyan(commit)}`,
    "Confirm revert",
  );

  if (!argv.y) {
    const ok = await p.confirm({
      message:
        mode === "destructive"
          ? "Proceed with rewriting history (force-push) for that branch?"
          : "Proceed with creating revert commit(s) on that branch?",
      initialValue: mode !== "destructive",
    });
    if (p.isCancel(ok) || !ok) exitCancelled("Revert aborted");
  }

  const cwd = mkdtempSync(join(tmpdir(), "hardfork-revert-"));
  const s = p.spinner();

  try {
    s.start("Cloning repo (temp)");
    await cloneRepoAllBranches(repo, cwd);
    s.stop(color.green("Cloned"));

    s.start(`Checking out ${branch}`);
    await execa("git", ["fetch", "origin", branch], { cwd, stdio: "pipe" });
    await execa("git", ["checkout", "-B", branch, `origin/${branch}`], { cwd, stdio: "pipe" });
    s.stop(color.green("Checked out"));

    // Ensure commit object exists locally; this handles cases where commit isn't on the fetched branch tip.
    await execa("git", ["fetch", "origin", commit], { cwd, stdio: "pipe" }).catch(() => { });

    if (mode === "destructive") {
      s.start("Resetting to commit");
      await execa("git", ["reset", "--hard", commit], { cwd, stdio: "pipe" });
      s.stop(color.green("Reset"));

      s.start(`Force-pushing to origin/${branch}`);
      await forcePushHeadToBranch(cwd, branch);
      s.stop(color.green("Pushed"));
    } else {
      s.start("Verifying commit is an ancestor of branch");
      const isAncestor = await execa("git", ["merge-base", "--is-ancestor", commit, "HEAD"], { cwd, stdio: "pipe" })
        .then(() => true)
        .catch(() => false);
      if (!isAncestor) {
        throw new Error(
          `Commit ${commit} is not an ancestor of ${branch}. Use --destructive to force-move, or pick a commit on that branch.`,
        );
      }
      s.stop(color.green("OK"));

      s.start("Reverting commits after target");
      const { stdout } = await execa("git", ["rev-list", "--reverse", `${commit}..HEAD`], { cwd, stdio: "pipe" });
      const toRevert = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      for (const sha of toRevert) {
        await execa("git", ["revert", "--no-edit", sha], { cwd, stdio: "pipe" });
      }
      s.stop(color.green("Reverted"));

      s.start(`Pushing to origin/${branch}`);
      await pushToNewRemote(cwd, branch);
      s.stop(color.green("Pushed"));
    }
  } catch (e) {
    s.stop(color.red("Revert failed"));
    p.log.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }

  p.outro(color.green("revert complete"));
}

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
