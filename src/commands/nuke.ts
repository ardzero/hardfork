import * as p from "@clack/prompts";
import color from "picocolors";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { execa } from "execa";
import { INTRO_TITLE_NUKE } from "@/lib/constants.ts";
import type { NukeArgv, NukeMode } from "@/lib/types.ts";
import { exitCancelled, promptUntilValue } from "@/lib/prompts-util.ts";
import { assertRemoteAccessWithRecovery } from "@/lib/remote-access.ts";
import { validateRemoteUrl } from "@/lib/validation.ts";
import {
  cloneRepo,
  cloneRepoAllBranchesShallow,
  deleteRemoteBranch,
  formatGitFailure,
  forcePushHeadToBranch,
  listRemoteBranches,
  preferredDefaultBranch,
  pushHeadToBranch,
  removeRepoContentsExceptGit,
} from "@/lib/git.ts";

export function showNukeHelp(): void {
  console.clear();
  p.intro(INTRO_TITLE_NUKE);
  console.log(color.bold("\nUsage:"));
  console.log(`  ${color.cyan("hardfork nuke [repoUrl]")} ${color.dim("[options]")}`);
  p.note(
    `${color.cyan("hardfork nuke https://github.com/you/repo.git")}\n  Interactive: choose branch/all branches, preserve vs wipe history, confirm\n\n` +
      `${color.cyan("hardfork nuke https://github.com/you/repo.git --branch main --preserve-history -y")}\n  Delete files on one branch with a new commit\n\n` +
      `${color.cyan("hardfork nuke https://github.com/you/repo.git --all-branches --wipe-history -y")}\n  Force-push fresh empty history to every remote branch\n\n` +
      `${color.cyan("hardfork nuke https://github.com/you/repo.git --branches-only --default-branch main -y")}\n  Delete extra remote branches and keep/create one default branch`,
    "Examples",
  );
  console.log(color.bold("\nOptions:"));
  console.log(`  ${color.cyan("--branch <name>")}        Branch to nuke (default: remote HEAD/main)`);
  console.log(`  ${color.cyan("--all-branches")}         Nuke all remote branches`);
  console.log(`  ${color.cyan("--branches-only")}        Delete remote branches and leave one default branch`);
  console.log(`  ${color.cyan("--default-branch <name>")} Default branch to keep/create with --branches-only (default: main)`);
  console.log(`  ${color.cyan("--preserve-history")}     Keep history; remove files in a new commit`);
  console.log(`  ${color.cyan("--wipe-history")}         Rewrite history with a fresh empty root commit`);
  console.log(`  ${color.cyan("-m, --message <text>")}   Commit message for the nuke commit`);
  console.log(`  ${color.cyan("-y, --yes")}              Skip prompts (requires repo and enough flags)`);
  console.log(`  ${color.cyan("-h, --help")}`);
  p.outro(color.dim("Nuke: empty a repo branch, all branches, or prune branches"));
}

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
    const t = await promptUntilValue<string>(() =>
      p.text({
        message: "Repository URL to nuke (GitHub or GitLab)",
        placeholder: "https://github.com/org/repo.git",
        validate: validateRemoteUrl,
      }),
    );
    repo = (t as string).trim();
  }
  while (true) {
    const repoErr = validateRemoteUrl(repo);
    if (repoErr) {
      p.log.error(repoErr);
      process.exit(1);
    }

    const access = await assertRemoteAccessWithRecovery({
      remoteUrl: repo,
      mode: "write",
      role: "destination",
      changeLabel: "Change target repo",
      disabled: argv.y,
    });
    if (access === "ok") break;

    const nextRepo = await promptUntilValue<string>(() =>
      p.text({
        message: "Repository URL to nuke (GitHub or GitLab)",
        placeholder: "https://github.com/org/repo.git",
        initialValue: repo,
        validate: validateRemoteUrl,
      }),
    );
    repo = (nextRepo as string).trim();
  }

  type NukeScope = "branch" | "all" | "branches-only";
  type DeleteBranchScope = "specific" | "all";
  if (argv.allBranches && argv.branchesOnly) {
    p.log.error("Use only one of --all-branches or --branches-only");
    process.exit(1);
  }

  const DEFAULT_NUKE_MESSAGE = "Nuke repository";
  type ReconfigureChoice = "nothing" | "scope" | "message" | "mode" | "branch" | "default-branch" | "delete-branches";
  let reconfigureChoices: ReconfigureChoice[] = [];
  let reconfiguring = false;
  let scope: NukeScope = argv.branchesOnly ? "branches-only" : argv.allBranches ? "all" : "branch";
  let commitMessage: string = argv.message?.trim() ?? "";
  let mode: NukeMode = "preserve";
  const defaultBranch = "main";
  let branch: string | undefined = argv.branch?.trim();
  let keptDefaultBranch: string = argv.defaultBranch?.trim() || defaultBranch;
  let selectedBranches: string[] = branch ? [branch] : [];
  let deleteBranchScope: DeleteBranchScope = "all";
  let remoteBranches: string[] = [];
  let plannedBranches: string[] = [];

  while (true) {
    if (reconfiguring) {
      const choices = await promptUntilValue<ReconfigureChoice[]>(() =>
        p.multiselect({
          message: "What do you want to reconfigure?",
          options: [
            {
              value: "nothing" as const,
              label: "Nothing",
              hint: "Show the confirmation again",
            },
            {
              value: "scope" as const,
              label: "What should be nuked?",
              hint:
                scope === "branches-only"
                  ? "Branches only"
                  : scope === "all"
                    ? "All branches"
                    : `Specific branches (${selectedBranches.length || 1})`,
            },
            ...(scope === "branches-only"
              ? [
                  {
                    value: "default-branch" as const,
                    label: "Default branch to keep/create",
                    hint: keptDefaultBranch,
                  },
                  {
                    value: "delete-branches" as const,
                    label: "Branches to delete",
                    hint:
                      deleteBranchScope === "all" ? "All remote branches except default" : `${plannedBranches.length || selectedBranches.length} selected`,
                  },
                ]
              : [
                  { value: "message" as const, label: "Commit message", hint: commitMessage || DEFAULT_NUKE_MESSAGE },
                  {
                    value: "mode" as const,
                    label: "Nuke mode",
                    hint: mode === "wipe" ? "Wipe history" : "Preserve history",
                  },
                  ...(scope === "branch"
                    ? [
                        {
                          value: "branch" as const,
                          label: "Branches to nuke",
                          hint: selectedBranches.join(", ") || branch || defaultBranch,
                        },
                      ]
                    : []),
                ]),
          ],
          initialValues: ["scope"],
          required: true,
        }),
      );
      reconfigureChoices = choices as ReconfigureChoice[];
      if (reconfigureChoices.includes("nothing")) {
        reconfigureChoices = [];
      }
    }

    const previousScope = scope;
    if ((!argv.allBranches && !argv.branchesOnly && !argv.branch && !argv.y && !reconfiguring) || reconfigureChoices.includes("scope")) {
      const sc = await promptUntilValue<NukeScope>(() =>
        p.select({
          message: "What should be nuked?",
          options: [
            { value: "branch" as const, label: "Specific branches", hint: "Select one or more remote branches" },
            { value: "all" as const, label: "All branches", hint: "Overwrites every branch in the remote" },
            {
              value: "branches-only" as const,
              label: "Branches only",
              hint: "Delete specific or extra remote branches",
            },
          ],
          initialValue: scope,
        }),
      );
      scope = sc as NukeScope;
    }
    const scopeChanged = previousScope !== scope;

    if (scope !== "branches-only" && ((!commitMessage && !reconfiguring) || reconfigureChoices.includes("message")) && !argv.y) {
      const msg = await promptUntilValue<string>(() =>
        p.text({
          message: "Commit message for the nuke commit",
          placeholder: DEFAULT_NUKE_MESSAGE,
          initialValue: commitMessage || DEFAULT_NUKE_MESSAGE,
          validate: (v) => (!v?.trim() ? "Commit message is required" : undefined),
        }),
      );
      commitMessage = (msg as string).trim();
    }
    if (!commitMessage) commitMessage = DEFAULT_NUKE_MESSAGE;

    if (argv.preserveHistory && argv.wipeHistory) {
      p.log.error("Use only one of --preserve-history or --wipe-history");
      process.exit(1);
    }
    if (scope === "branches-only" && (argv.preserveHistory || argv.wipeHistory)) {
      p.log.error("--branches-only cannot be combined with --preserve-history or --wipe-history");
      process.exit(1);
    }
    if (argv.wipeHistory && !reconfiguring) mode = "wipe";
    else if (argv.preserveHistory && !reconfiguring) mode = "preserve";
    else if (scope !== "branches-only" && (reconfigureChoices.includes("mode") || !reconfiguring) && !argv.y) {
      const m = await promptUntilValue<NukeMode>(() =>
        p.select({
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
          initialValue: mode,
        }),
      );
      mode = m as NukeMode;
    }

    if (scope === "branch") {
      if ((!branch || reconfigureChoices.includes("branch") || (scopeChanged && reconfiguring)) && !argv.y) {
        remoteBranches = await listRemoteBranches(repo);
        if (remoteBranches.length === 0) {
          p.log.error("No branches found on remote.");
          process.exit(1);
        }
        const initialBranch = selectedBranches[0] ?? branch ?? preferredDefaultBranch(remoteBranches, defaultBranch);
        const branches = await promptUntilValue<string[]>(() =>
          p.multiselect({
            message: "Branches to nuke",
            options: remoteBranches.map((b) => ({ value: b, label: b })),
            initialValues: remoteBranches.includes(initialBranch) ? [initialBranch] : [],
            required: true,
          }),
        );
        selectedBranches = branches as string[];
        branch = selectedBranches[0];
      }
      if (selectedBranches.length === 0) selectedBranches = [branch || defaultBranch];
      branch = selectedBranches[0];
    }
    if (scope === "branches-only") {
      remoteBranches = await listRemoteBranches(repo);
      if (remoteBranches.length === 0) {
        p.log.error("No branches found on remote.");
        process.exit(1);
      }
      if (!keptDefaultBranch && argv.y) keptDefaultBranch = defaultBranch;
      if (
        ((!argv.defaultBranch || argv.defaultBranch.trim() === "") && !argv.y && !reconfiguring) ||
        reconfigureChoices.includes("default-branch") ||
        (scopeChanged && reconfiguring)
      ) {
        const b = await promptUntilValue<string>(() =>
          p.text({
            message: "Default branch to keep/create",
            placeholder: defaultBranch,
            initialValue: keptDefaultBranch || defaultBranch,
            validate: (v) => (!v?.trim() ? "Default branch is required" : undefined),
          }),
        );
        keptDefaultBranch = (b as string).trim();
      }
      if (!argv.y && (reconfigureChoices.includes("delete-branches") || (scopeChanged && reconfiguring) || (!reconfiguring && selectedBranches.length === 0))) {
        const deleteScope = await promptUntilValue<DeleteBranchScope>(() =>
          p.select({
            message: "Which branches should be deleted?",
            options: [
              {
                value: "specific" as const,
                label: "Specific branches",
                hint: "Select one or more branches to delete",
              },
              {
                value: "all" as const,
                label: "All branches",
                hint: `Delete every branch except ${keptDefaultBranch}`,
              },
            ],
            initialValue: deleteBranchScope,
          }),
        );
        deleteBranchScope = deleteScope as DeleteBranchScope;

        if (deleteBranchScope === "specific") {
          const deletableBranches = remoteBranches.filter((b) => b !== keptDefaultBranch);
          if (deletableBranches.length === 0) {
            p.log.error(`No branches can be deleted while keeping ${keptDefaultBranch}.`);
            process.exit(1);
          }
          const branches = await promptUntilValue<string[]>(() =>
            p.multiselect({
              message: "Branches to delete",
              options: deletableBranches.map((b) => ({ value: b, label: b })),
              initialValues: selectedBranches.filter((b) => deletableBranches.includes(b)),
              required: true,
            }),
          );
          selectedBranches = branches as string[];
        } else {
          selectedBranches = [];
        }
      }
    }

    remoteBranches =
      remoteBranches.length > 0 || (scope !== "all" && scope !== "branches-only") ? remoteBranches : await listRemoteBranches(repo);
    const plannedBranchesRaw =
      scope === "all"
        ? remoteBranches
        : scope === "branches-only"
          ? deleteBranchScope === "all"
            ? remoteBranches.filter((b) => b !== keptDefaultBranch)
            : selectedBranches.filter((b) => b !== keptDefaultBranch)
          : selectedBranches;
    plannedBranches = plannedBranchesRaw.length === 0 && scope === "branch" ? [branch || defaultBranch] : plannedBranchesRaw;

    const shownBranches =
      plannedBranches.length > 25
        ? `${plannedBranches.slice(0, 25).join("\n")}\n... (+${plannedBranches.length - 25} more)`
        : plannedBranches.join("\n") || "(none)";

    const summaryTitle = mode === "wipe" || scope === "branches-only" ? "Confirm nuke (danger)" : "Confirm nuke";
    const warningLine = mode === "wipe" || scope === "branches-only" ? `${color.bold("This is NOT reversible.")}\n` : "";
    const modeLabel =
      scope === "branches-only" ? "branches only (delete remote branches)" : mode === "wipe" ? "wipe history (force-push)" : "preserve history";

    p.note(
      `${warningLine}` +
        `Mode: ${color.cyan(modeLabel)}\n` +
        `Repo: ${color.cyan(repo)}\n` +
        (scope === "branches-only" ? `Keep/create default branch: ${color.cyan(keptDefaultBranch)}\n` : `Commit: ${color.cyan(commitMessage)}\n`) +
        `${scope === "branches-only" ? "Delete branches" : "Branches"} (${plannedBranches.length}):\n${shownBranches}`,
      summaryTitle,
    );

    if (argv.y) break;

    const action = await promptUntilValue<"yes" | "no" | "reconfigure">(() =>
      p.select({
        message:
          scope === "branches-only"
            ? "Proceed with deleting the branches above?"
            : mode === "wipe"
              ? "Proceed with force-push on the branches above?"
              : "Proceed with nuking the branches above?",
        options: [
          { value: "yes" as const, label: "Yes" },
          { value: "no" as const, label: "No" },
          { value: "reconfigure" as const, label: "Reconfigure", hint: "Change the selections above" },
        ],
        initialValue: mode !== "wipe" && scope !== "branches-only" ? "yes" : "no",
      }),
    );

    if (action === "yes") break;
    if (action === "no") exitCancelled("Nuke aborted");
    reconfiguring = true;
    reconfigureChoices = [];
  }

  const cwd = mkdtempSync(join(tmpdir(), "hardfork-nuke-"));
  const s = p.spinner();

  try {
    if (scope === "branches-only") {
      s.start("Initializing empty repo (temp)");
      await execa("git", ["init"], { cwd });
      await execa("git", ["remote", "add", "origin", repo], { cwd });
      await execa("git", ["checkout", "-B", keptDefaultBranch], { cwd });
      await execa("git", ["commit", "--allow-empty", "-m", `Keep ${keptDefaultBranch}`], { cwd });
      s.stop(color.green("Initialized"));

      if (!remoteBranches.includes(keptDefaultBranch)) {
        s.start(`Creating default branch ${keptDefaultBranch}`);
        await pushHeadToBranch(cwd, keptDefaultBranch);
        s.stop(color.green(`Created ${keptDefaultBranch}`));
      }

      for (const b of plannedBranches) {
        s.start(`Deleting branch ${b}`);
        await deleteRemoteBranch(cwd, b);
        s.stop(color.green(`Deleted ${b}`));
      }
    } else if (mode === "preserve") {
      s.start(scope === "all" ? "Cloning target repo (all branches, temp)" : "Cloning target repo (temp)");
      if (scope === "all") {
        await cloneRepoAllBranchesShallow(repo, cwd);
      } else {
        await cloneRepo(repo, cwd, false, undefined, false);
      }
      s.stop(color.green("Cloned"));

      const branches: string[] = scope === "all" ? await listRemoteBranches(repo) : plannedBranches;
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
        const b = branch || defaultBranch;
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
    p.log.error(await formatGitFailure(e, { operation: "git", role: "destination", remoteUrl: repo }));
    process.exit(1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }

  const scopeLabel =
    scope === "all"
      ? "all branches"
      : scope === "branches-only"
        ? `branches only; kept default: ${keptDefaultBranch}`
        : `branches: ${plannedBranches.join(", ") || branch || defaultBranch}`;
  const doneMode = scope === "branches-only" ? "branches-only" : mode;
  p.note(`${color.cyan(repo)}\nTarget: ${color.cyan(scopeLabel)}\nMode: ${color.cyan(doneMode)}`, "Done");
  p.outro(color.green("nuke complete"));
}
