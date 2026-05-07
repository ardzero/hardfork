import * as p from "@clack/prompts";
import color from "picocolors";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";
import { INTRO_TITLE } from "@/lib/constants.ts";
import type { BranchScope, CloneMode, ParsedArgv, RepoPreflight } from "@/lib/types.ts";
import { exitCancelled } from "@/lib/prompts-util.ts";
import { validateLocalDir, validateRemoteUrl, validateSourceUrl } from "@/lib/validation.ts";
import {
  allBranchesLooksExpensive,
  branchOptions,
  describeHistoryChoice,
  estimateTransferSizeKb,
  formatSizeKb,
  fullHistoryLooksExpensive,
  getRepoCommitCount,
  getRepoSizeKb,
  parseCommitDepth,
  parseSourceRepo,
  repoSlugFromUrl,
} from "@/lib/repo-preflight.ts";
import {
  cloneRepo,
  collapseToSingleCommit,
  deleteRemoteBranch,
  fetchSpecificBranches,
  forcePushHeadToBranch,
  isNonFastForwardPushError,
  listClonedSourceBranches,
  listRemoteBranches,
  preferredDefaultBranch,
  preserveRemoteHistoryButReplaceFiles,
  pushClonedSourceBranches,
  pushToNewRemoteCapture,
  replaySourceHistoryOntoRemoteBranch,
  resolveBranchToPush,
  setOriginUrl,
} from "@/lib/git.ts";

export function showHelp(): void {
  console.clear();
  p.intro(INTRO_TITLE);
  console.log(color.bold("\nUsage:"));
  console.log(`  ${color.cyan("hardfork")} ${color.dim("[options]")}`);
  console.log(`  ${color.cyan("hardfork nuke [repoUrl]")} ${color.dim("[options]")}`);
  console.log(`  ${color.cyan("hardfork revert [repoUrl] [commit]")} ${color.dim("[options]")}`);
  console.log(`  ${color.cyan("bun run src/cli.ts")} ${color.dim("[options]")}`);
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

export async function runHardfork(argv: ParsedArgv): Promise<void> {
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
