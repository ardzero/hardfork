import * as p from "@clack/prompts";
import color from "picocolors";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { execa } from "execa";
import { INTRO_TITLE_REVERT } from "@/lib/constants.ts";
import type { RevertArgv } from "@/lib/types.ts";
import { exitCancelled, promptUntilValue } from "@/lib/prompts-util.ts";
import { validateCommitHash, validateRemoteUrl } from "@/lib/validation.ts";
import {
  cloneRepoAllBranches,
  forcePushHeadToBranch,
  getRemoteHeadBranch,
  pushToNewRemote,
} from "@/lib/git.ts";

export function showRevertHelp(): void {
  console.clear();
  p.intro(INTRO_TITLE_REVERT);
  console.log(color.bold("\nUsage:"));
  console.log(`  ${color.cyan("hardfork revert [repoUrl] [commit]")} ${color.dim("[options]")}`);
  p.note(
    `${color.cyan("hardfork revert https://github.com/you/repo.git abc1234")}\n  Interactive: choose branch and revert mode, then confirm\n\n` +
      `${color.cyan("hardfork revert https://github.com/you/repo.git abc1234 --branch main --keep-history -y")}\n  Create revert commit(s) without rewriting history\n\n` +
      `${color.cyan("hardfork revert https://github.com/you/repo.git abc1234 --branch main --destructive -y")}\n  Hard-reset the branch to the commit and force-push`,
    "Examples",
  );
  console.log(color.bold("\nOptions:"));
  console.log(`  ${color.cyan("--branch <name>")}     Branch to revert (default: remote HEAD or main)`);
  console.log(`  ${color.cyan("--keep-history")}     Revert via new commit(s), no history rewrite`);
  console.log(`  ${color.cyan("--destructive")}      Hard reset + force-push, rewrites history`);
  console.log(`  ${color.cyan("-y, --yes")}          Skip prompts (requires repo and commit)`);
  console.log(`  ${color.cyan("-h, --help")}`);
  p.outro(color.dim("Revert: move one remote branch back to an earlier commit"));
}

export async function runRevert(argv: RevertArgv): Promise<void> {
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
    const t = await promptUntilValue<string>(() =>
      p.text({
        message: "Repository URL (GitHub or GitLab)",
        placeholder: "https://github.com/org/repo.git",
        validate: validateRemoteUrl,
      }),
    );
    repo = (t as string).trim();
  }
  const repoErr = validateRemoteUrl(repo);
  if (repoErr) {
    p.log.error(repoErr);
    process.exit(1);
  }

  if (!commit) {
    const h = await promptUntilValue<string>(() =>
      p.text({
        message: "Commit hash to revert to",
        placeholder: "abc1234…",
        validate: validateCommitHash,
      }),
    );
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
    const b = await promptUntilValue<string>(() =>
      p.text({
        message: "Branch to revert",
        placeholder: defaultBranch,
        initialValue: defaultBranch,
        validate: (v) => (!v?.trim() ? "Branch is required" : undefined),
      }),
    );
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
    const m = await promptUntilValue<RevertMode>(() =>
      p.select({
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
      }),
    );
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
    const ok = await promptUntilValue<boolean>(() =>
      p.confirm({
        message:
          mode === "destructive"
            ? "Proceed with rewriting history (force-push) for that branch?"
            : "Proceed with creating revert commit(s) on that branch?",
        initialValue: mode !== "destructive",
      }),
    );
    if (!ok) exitCancelled("Revert aborted");
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

    await execa("git", ["fetch", "origin", commit], { cwd, stdio: "pipe" }).catch(() => {});

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
