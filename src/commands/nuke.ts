import * as p from "@clack/prompts";
import color from "picocolors";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { execa } from "execa";
import { INTRO_TITLE_NUKE } from "@/lib/constants.ts";
import type { NukeArgv, NukeMode } from "@/lib/types.ts";
import { exitCancelled } from "@/lib/prompts-util.ts";
import { validateRemoteUrl } from "@/lib/validation.ts";
import {
  cloneRepo,
  cloneRepoAllBranchesShallow,
  forcePushHeadToBranch,
  listRemoteBranches,
  pushHeadToBranch,
  removeRepoContentsExceptGit,
} from "@/lib/git.ts";

export async function runNuke(argv: NukeArgv): Promise<void> {
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

  const plannedBranchesRaw = scope === "all" ? await listRemoteBranches(repo) : [singleBranch];
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
      await execa("git", ["checkout", "-B", defaultBranch], { cwd });
      await execa("git", ["commit", "--allow-empty", "-m", commitMessage], { cwd });
      s.stop(color.green("Initialized"));

      const branches = plannedBranches;

      if (branches.length === 0) {
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
