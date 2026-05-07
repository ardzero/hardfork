import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { execa } from "execa";
import type { ExecaLikeError } from "@/lib/types.ts";

export async function getRemoteHeadBranch(remoteUrl: string): Promise<string | undefined> {
  try {
    const { stdout } = await execa("git", ["ls-remote", "--symref", remoteUrl, "HEAD"], { stdio: "pipe" });
    const m = stdout.match(/ref:\s+refs\/heads\/([^\s]+)\s+HEAD/);
    return m?.[1];
  } catch {
    return undefined;
  }
}

export async function listRemoteBranches(remoteUrl: string): Promise<string[]> {
  const { stdout } = await execa("git", ["ls-remote", "--heads", remoteUrl], { stdio: "pipe" });
  const branches = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split("\t")[1] ?? "")
    .filter((ref) => ref.startsWith("refs/heads/"))
    .map((ref) => ref.replace(/^refs\/heads\//, ""))
    .filter(Boolean);
  return Array.from(new Set(branches));
}

export function preferredDefaultBranch(branches: string[], fallback: string): string {
  if (branches.includes("main")) return "main";
  if (branches.includes("master")) return "master";
  if (branches.includes(fallback)) return fallback;
  return branches[0] ?? fallback;
}

/** URL branch wins; else remote `HEAD` symref (host default); else main/master; never arbitrary list order. */
export function resolveRemoteDefaultBranch(
  branches: string[],
  urlBranch: string | undefined,
  remoteHead: string | undefined,
): string | undefined {
  if (urlBranch) return urlBranch;
  if (remoteHead && branches.includes(remoteHead)) return remoteHead;
  if (branches.includes("main")) return "main";
  if (branches.includes("master")) return "master";
  return undefined;
}

export async function gitBranchShowCurrent(cwd: string): Promise<string> {
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

export async function resolveBranchToPush(cwd: string): Promise<string> {
  const current = await gitBranchShowCurrent(cwd);
  const remoteDefault = await gitDefaultBranchFromRemote(cwd);
  if (remoteDefault && current === remoteDefault) return current;
  return current;
}

export async function collapseToSingleCommit(cwd: string): Promise<void> {
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

export async function collapseRemoteBranchesToSingleCommits(cwd: string, branches: string[]): Promise<void> {
  for (const branch of branches) {
    const orphanBranch = `__hardfork_orphan_${branch.replace(/[^A-Za-z0-9._-]/g, "_")}`;
    await execa("git", ["checkout", "--detach", `origin/${branch}`], { cwd, stdio: "pipe" });
    await execa("git", ["checkout", "--orphan", orphanBranch], { cwd, stdio: "pipe" });
    await execa("git", ["add", "-A"], { cwd, stdio: "pipe" });
    await execa("git", ["commit", "-m", "Initial commit"], { cwd, stdio: "pipe" }).catch(async () => {
      await execa("git", ["checkout", "--detach", `origin/${branch}`], { cwd, stdio: "pipe" }).catch(() => {});
      throw new Error(`Nothing to commit for ${branch} after orphan checkout — empty branch?`);
    });
    await execa("git", ["branch", "-D", branch], { cwd, stdio: "pipe" }).catch(() => {});
    await execa("git", ["branch", "-m", branch], { cwd, stdio: "pipe" });
  }
}

export async function cloneRepo(
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

export async function fetchSpecificBranches(cwd: string, branches: string[], depth?: number): Promise<void> {
  for (const branch of branches) {
    const args = ["fetch", "origin"];
    if (depth) args.push("--depth", String(depth));
    args.push(`refs/heads/${branch}:refs/remotes/origin/${branch}`);
    await execa("git", args, { cwd, stdio: "pipe" });
  }
}

export async function materializeShallowHistory(cwd: string): Promise<void> {
  const { stdout: isShallowOut } = await execa("git", ["rev-parse", "--is-shallow-repository"], {
    cwd,
    stdio: "pipe",
  });
  if (isShallowOut.trim() !== "true") return;

  const { stdout: shallowPathOut } = await execa("git", ["rev-parse", "--git-path", "shallow"], {
    cwd,
    stdio: "pipe",
  });
  const gitShallowPath = shallowPathOut.trim();
  const shallowPath = gitShallowPath && isAbsolute(gitShallowPath) ? gitShallowPath : resolve(cwd, gitShallowPath);
  if (!shallowPath || !existsSync(shallowPath)) return;

  const boundaryCommits = readFileSync(shallowPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (boundaryCommits.length === 0) return;

  for (const sha of boundaryCommits) {
    await execa("git", ["replace", "--force", "--graft", sha], { cwd, stdio: "pipe" });
  }

  try {
    await execa("git", ["filter-branch", "--force", "--", "--all"], {
      cwd,
      stdio: "pipe",
      env: { FILTER_BRANCH_SQUELCH_WARNING: "1" },
    });
    rmSync(shallowPath, { force: true });
  } finally {
    for (const sha of boundaryCommits) {
      await execa("git", ["replace", "-d", sha], { cwd, stdio: "pipe" }).catch(() => {});
    }
  }
}

export async function cloneRepoAllBranchesShallow(url: string, dest: string): Promise<void> {
  await execa("git", ["clone", "--no-single-branch", "--depth", "1", url, dest], { stdio: "pipe" });
}

export async function cloneRepoAllBranches(url: string, dest: string): Promise<void> {
  await execa("git", ["clone", "--no-single-branch", url, dest], { stdio: "pipe" });
}

export async function setOriginUrl(cwd: string, newUrl: string): Promise<void> {
  await execa("git", ["remote", "set-url", "origin", newUrl], { cwd });
}

export async function preserveSourceRemoteAndSetOrigin(cwd: string, newUrl: string): Promise<void> {
  await execa("git", ["remote", "remove", "source"], { cwd, stdio: "pipe" }).catch(() => {});
  await execa("git", ["remote", "rename", "origin", "source"], { cwd, stdio: "pipe" });
  await execa("git", ["remote", "add", "origin", newUrl], { cwd, stdio: "pipe" });
}

export async function pushToNewRemote(cwd: string, branch: string): Promise<void> {
  await runGitPush(cwd, ["push", "-u", "origin", branch]);
}

export type RemoteAccessMode = "read" | "write";

export function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const e = err as ExecaLikeError;
    return [e.shortMessage, e.message, e.stderr, e.stdout, e.all].filter(Boolean).join("\n");
  }
  return String(err);
}

function errorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  return (err as ExecaLikeError).code;
}

type GitFailureRole = "source" | "destination" | "local";

type GitFailureContext = {
  operation: "clone" | "push" | "fetch" | "commit" | "probe" | "git";
  role?: GitFailureRole;
  remoteUrl?: string;
};

async function gitConfigValue(key: string): Promise<string | undefined> {
  return execa("git", ["config", "--get", key], { stdio: "pipe" })
    .then(({ stdout }) => stdout.trim() || undefined)
    .catch(() => undefined);
}

async function commandOutput(command: string, args: string[]): Promise<string | undefined> {
  return execa(command, args, { stdio: "pipe" })
    .then(({ stdout, stderr }) => stdout.trim() || stderr.trim() || undefined)
    .catch(() => undefined);
}

async function currentUserInfo(): Promise<string> {
  const [gitName, gitEmail, ghUser, ghStatus] = await Promise.all([
    gitConfigValue("user.name"),
    gitConfigValue("user.email"),
    commandOutput("gh", ["api", "user", "--jq", ".login"]),
    commandOutput("gh", ["auth", "status"]),
  ]);

  return [
    "Current user info:",
    `  git user.name: ${gitName ?? "(not configured)"}`,
    `  git user.email: ${gitEmail ?? "(not configured)"}`,
    `  GitHub CLI user: ${ghUser ?? "(not authenticated or gh not installed)"}`,
    ghStatus ? `  gh auth status: ${ghStatus.split("\n")[0]}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function isGitMissingError(err: unknown): boolean {
  const msg = errorText(err).toLowerCase();
  return errorCode(err) === "ENOENT" || msg.includes("command not found: git") || msg.includes("spawn git enoent");
}

function isUserNotConfiguredError(err: unknown): boolean {
  const msg = errorText(err).toLowerCase();
  return msg.includes("author identity unknown") || msg.includes("please tell me who you are") || msg.includes("unable to auto-detect email address");
}

function isAuthOrAccessError(err: unknown): boolean {
  const msg = errorText(err).toLowerCase();
  return (
    msg.includes("authentication failed") ||
    msg.includes("permission denied") ||
    msg.includes("could not read username") ||
    msg.includes("repository not found") ||
    msg.includes("not found") ||
    msg.includes("access denied") ||
    msg.includes("write access to repository not granted") ||
    msg.includes("the requested url returned error: 401") ||
    msg.includes("the requested url returned error: 403") ||
    msg.includes("fatal: could not read from remote repository")
  );
}

async function runGitPush(cwd: string, args: string[]): Promise<void> {
  const res = await execa("git", args, { cwd, stdio: "pipe", all: true });
  if (res.all?.trim()) {
    process.stdout.write(`${res.all}\n`);
  }
}

export async function assertRemoteAccess(remoteUrl: string, mode: RemoteAccessMode): Promise<void> {
  if (mode === "read") {
    await execa("git", ["ls-remote", "--heads", remoteUrl], { stdio: "pipe", all: true });
    return;
  }

  const cwd = mkdtempSync(join(tmpdir(), "hardfork-access-"));
  try {
    await execa("git", ["init"], { cwd, stdio: "pipe" });
    await execa("git", ["remote", "add", "origin", remoteUrl], { cwd, stdio: "pipe" });
    await execa("git", ["commit", "--allow-empty", "-m", "hardfork permission check"], {
      cwd,
      stdio: "pipe",
      env: {
        GIT_AUTHOR_NAME: "hardfork",
        GIT_AUTHOR_EMAIL: "hardfork@example.invalid",
        GIT_COMMITTER_NAME: "hardfork",
        GIT_COMMITTER_EMAIL: "hardfork@example.invalid",
      },
    });
    await execa("git", ["push", "--dry-run", "origin", "HEAD:refs/heads/__hardfork_permission_check__"], {
      cwd,
      stdio: "pipe",
      all: true,
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function isNetworkError(err: unknown): boolean {
  const msg = errorText(err).toLowerCase();
  return (
    msg.includes("could not resolve host") ||
    msg.includes("failed to connect") ||
    msg.includes("connection timed out") ||
    msg.includes("connection reset") ||
    msg.includes("network is unreachable") ||
    msg.includes("temporary failure in name resolution") ||
    msg.includes("operation timed out") ||
    msg.includes("early eof") ||
    msg.includes("rpc failed")
  );
}

export async function formatGitFailure(err: unknown, context: GitFailureContext): Promise<string> {
  const raw = errorText(err).trim();
  const rawBlock = raw ? `\n\nGit said:\n${raw}` : "";
  const remoteLine = context.remoteUrl ? `\nRemote: ${context.remoteUrl}` : "";

  if (isGitMissingError(err)) {
    return `Git is not installed or is not available on PATH.\nInstall Git, then run this command again.${rawBlock}`;
  }

  if (isUserNotConfiguredError(err)) {
    return (
      `Git user identity is not configured, so Git cannot create commits.\n` +
      `Run:\n  git config --global user.name "Your Name"\n  git config --global user.email "you@example.com"\n\n` +
      (await currentUserInfo()) +
      rawBlock
    );
  }

  if (isNetworkError(err)) {
    return `Network failure while running git ${context.operation}.${remoteLine}\nCheck DNS/VPN/proxy/connectivity, then retry.${rawBlock}`;
  }

  if (isAuthOrAccessError(err)) {
    const target =
      context.role === "source"
        ? "source/origin repository"
        : context.role === "destination"
          ? "destination repository"
          : "repository";
    const permissionHint =
      context.operation === "push" || context.role === "destination"
        ? "Make sure the authenticated account has write access to the destination repo."
        : "If this is a private source/origin repo, authenticate with an account that can read it.";

    return (
      `Git could not access the ${target}.${remoteLine}\n` +
      `${permissionHint}\n\n` +
      (await currentUserInfo()) +
      (raw ? `\n\nGit said:\n${raw}` : "")
    );
  }

  return raw || String(err);
}

export function isNonFastForwardPushError(err: unknown): boolean {
  const msg = errorText(err);
  return (
    msg.includes("non-fast-forward") ||
    msg.includes("fetch first") ||
    msg.includes("[rejected]") ||
    msg.includes("failed to push some refs")
  );
}

export async function pushToNewRemoteCapture(cwd: string, branch: string): Promise<void> {
  await runGitPush(cwd, ["push", "-u", "origin", branch]);
}

export async function listClonedSourceBranches(cwd: string): Promise<string[]> {
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

export async function pushClonedSourceBranches(cwd: string, branches: string[], force = false): Promise<void> {
  if (branches.length === 0) return;
  await runGitPush(
    cwd,
    [
      "push",
      ...(force ? ["--force"] : []),
      "-u",
      "origin",
      ...branches.map((branch) => `refs/remotes/origin/${branch}:refs/heads/${branch}`),
    ],
  );
}

export async function pushLocalBranches(cwd: string, branches: string[], force = false): Promise<void> {
  if (branches.length === 0) return;
  await runGitPush(cwd, [
    "push",
    ...(force ? ["--force"] : []),
    "-u",
    "origin",
    ...branches.map((branch) => `${branch}:refs/heads/${branch}`),
  ]);
}

export async function exportHeadTreeToDir(repoCwd: string, outDir: string): Promise<void> {
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

export async function preserveRemoteHistoryButReplaceFiles(params: {
  repoCwd: string;
  branch: string;
  commitMessage: string;
}): Promise<void> {
  const { repoCwd, branch, commitMessage } = params;
  const snapshotDir = mkdtempSync(join(tmpdir(), "hardfork-snapshot-"));
  try {
    await exportHeadTreeToDir(repoCwd, snapshotDir);

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

export async function replaySourceHistoryOntoRemoteBranch(params: {
  repoCwd: string;
  branch: string;
  sourceTip: string;
  cleanupMessage: string;
}): Promise<void> {
  const { repoCwd, branch, sourceTip, cleanupMessage } = params;

  const { stdout: revListOut } = await execa("git", ["rev-list", "--reverse", sourceTip], { cwd: repoCwd, stdio: "pipe" });
  const sourceCommits = revListOut
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (sourceCommits.length === 0) {
    throw new Error("Could not read source commit history to replay.");
  }

  await execa("git", ["fetch", "origin", branch], { cwd: repoCwd, stdio: "pipe" });
  await execa("git", ["checkout", "-B", branch, `origin/${branch}`], { cwd: repoCwd, stdio: "pipe" });

  removeRepoContentsExceptGit(repoCwd);
  await execa("git", ["add", "-A"], { cwd: repoCwd, stdio: "pipe" });
  await execa("git", ["commit", "--allow-empty", "-m", cleanupMessage], { cwd: repoCwd, stdio: "pipe" });

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

export async function pushHeadToBranch(cwd: string, branch: string): Promise<void> {
  await runGitPush(cwd, ["push", "-u", "origin", `HEAD:${branch}`]);
}

export async function forcePushHeadToBranch(cwd: string, branch: string): Promise<void> {
  await runGitPush(cwd, ["push", "--force", "-u", "origin", `HEAD:${branch}`]);
}

export async function deleteRemoteBranch(cwd: string, branch: string): Promise<void> {
  await execa("git", ["push", "origin", "--delete", branch], { cwd, stdio: "pipe" });
}

export function removeRepoContentsExceptGit(repoRoot: string): void {
  const entries = readdirSync(repoRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    rmSync(join(repoRoot, entry.name), { recursive: true, force: true });
  }
}
