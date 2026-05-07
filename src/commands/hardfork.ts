import * as p from "@clack/prompts";
import color from "picocolors";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
import { INTRO_TITLE } from "@/lib/constants.ts";
import type { BranchScope, CloneMode, ParsedArgv, RepoPreflight } from "@/lib/types.ts";
import { exitCancelled, promptUntilValue } from "@/lib/prompts-util.ts";
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
  collapseRemoteBranchesToSingleCommits,
  collapseToSingleCommit,
  deleteRemoteBranch,
  fetchSpecificBranches,
  formatGitFailure,
  forcePushHeadToBranch,
  getRemoteHeadBranch,
  isNonFastForwardPushError,
  listClonedSourceBranches,
  listRemoteBranches,
  materializeShallowHistory,
  preserveSourceRemoteAndSetOrigin,
  probeRemoteSizeEstimatesKb,
  preferredDefaultBranch,
  resolveRemoteDefaultBranch,
  preserveRemoteHistoryButReplaceFiles,
  pushClonedSourceBranches,
  pushLocalBranches,
  pushToNewRemoteCapture,
  replaySourceHistoryOntoRemoteBranch,
  resolveBranchToPush,
  setOriginUrl,
} from "@/lib/git.ts";
import { assertRemoteAccessWithRecovery } from "@/lib/remote-access.ts";

function normalizeGitRemoteUrlForComparison(value: string): string {
  return value
    .trim()
    .replace(/^git\+/, "")
    .replace(/^git@(github|gitlab)\.com:/i, "https://$1.com/")
    .replace(/\.git$/i, "")
    .replace(/\/+$/g, "")
    .toLowerCase();
}

function validateDestinationIsNotSource(sourceUrl: string, destinationUrl: string | undefined): string | undefined {
  if (!destinationUrl?.trim()) return undefined;
  if (normalizeGitRemoteUrlForComparison(sourceUrl) === normalizeGitRemoteUrlForComparison(destinationUrl)) {
    return "Destination remote must be different from the source repository";
  }
  return undefined;
}

function terminalLink(href: string, text: string): string {
  return `\u001B]8;;${href}\u001B\\${text}\u001B]8;;\u001B\\`;
}

function repoWebUrl(remoteUrl: string): string {
  const normalized = remoteUrl.trim().replace(/^git\+/, "").replace(/\.git$/i, "");
  const sshMatch = /^git@(github|gitlab)\.com:(.+)$/i.exec(normalized);
  if (sshMatch) {
    const [, host, repoPath] = sshMatch;
    if (host && repoPath) return `https://${host.toLowerCase()}.com/${repoPath.replace(/^\/+/, "")}`;
  }
  return normalized;
}

function formatRepoLink(remoteUrl: string): string {
  const webUrl = repoWebUrl(remoteUrl);
  return terminalLink(webUrl, color.cyan(webUrl));
}

function formatLocalPathLink(localPath: string): string {
  const displayPath = relative(process.cwd(), localPath) || ".";
  return terminalLink(pathToFileURL(localPath).href, color.cyan(displayPath));
}

type SpinnerLike = { start: (message: string) => void };

function startRotatingSpinner(spinner: SpinnerLike, messages: string[], intervalMs = 1200): () => void {
  if (messages.length === 0) return () => {};
  void intervalMs;
  // Clack's spinner.start() writes a new row each time, so timer-based rotation
  // causes duplicate status lines. Keep one stable helpful message per phase.
  spinner.start(messages[0] ?? "Working…");
  return () => {};
}

export function showHelp(): void {
  console.clear();
  p.intro(INTRO_TITLE);
  console.log(color.bold("\nUsage:"));
  console.log(`  ${color.cyan("hardfork")} ${color.dim("[options]")}`);
  console.log(`  ${color.cyan("hardfork nuke [repoUrl]")} ${color.dim("[options]")}`);
  console.log(`  ${color.cyan("hardfork revert [repoUrl] [commit]")} ${color.dim("[options]")}`);
  console.log(`  ${color.cyan("bun run src/cli.ts")} ${color.dim("[options]")}`);
  p.note(
    `${color.cyan("hardfork")}\n  Interactive: source URL → clone mode → branches → history → estimate → remote → push\n\n` +
      `${color.cyan("hardfork --source https://github.com/you/old.git --remote git@github.com:you/new.git -y")}\n  Non-interactive with push\n\n` +
      `${color.cyan("hardfork nuke https://github.com/you/repo.git")}\n  Make a repo empty (prompt preserve vs wipe history)\n\n` +
      `${color.cyan("hardfork revert https://github.com/you/repo.git <commit>")}\n  Move a branch back to a commit\n\n` +
      `${color.dim("For more nuke details:")} ${color.cyan("hardfork nuke --help")}\n` +
      `${color.dim("For more revert details:")} ${color.cyan("hardfork revert --help")}`,
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
    const t = await promptUntilValue<string>(() =>
      p.text({
        message: "Source repository URL (GitHub or GitLab)",
        placeholder: "https://github.com/org/repo.git",
        validate: validateSourceUrl,
      }),
    );
    source = t as string;
  }

  if (!source) {
    p.log.error("Source URL is required (--source or positional)");
    process.exit(1);
  }

  let sourceRepo = parseSourceRepo(source);
  let sourceCloneUrl = sourceRepo.cloneUrl;
  let sourceBranch = argv.branch?.trim() || sourceRepo.branch;

  while (true) {
    const srcErr = validateSourceUrl(source);
    if (srcErr) {
      p.log.error(srcErr);
      process.exit(1);
    }

    sourceRepo = parseSourceRepo(source);
    sourceCloneUrl = sourceRepo.cloneUrl;
    sourceBranch = argv.branch?.trim() || sourceRepo.branch;

    const access = await assertRemoteAccessWithRecovery({
      remoteUrl: sourceCloneUrl,
      mode: "read",
      role: "source",
      changeLabel: "Change source repo",
      disabled: argv.y,
    });
    if (access === "ok") break;

    const nextSource = await promptUntilValue<string>(() =>
      p.text({
        message: "Source repository URL (GitHub or GitLab)",
        placeholder: "https://github.com/org/repo.git",
        initialValue: source,
        validate: validateSourceUrl,
      }),
    );
    source = (nextSource as string).trim();
  }

  let cloneMode: CloneMode = "normal";
  if (argv.temp && argv.normal) {
    p.log.error("Use only one of --temp or --normal");
    process.exit(1);
  }
  if (argv.temp) cloneMode = "temp";
  else if (argv.normal) cloneMode = "normal";
  else if (!argv.y) {
    const mode = await promptUntilValue<CloneMode>(() =>
      p.select({
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
      }),
    );
    cloneMode = mode as CloneMode;
  }

  const probeSpinner = p.spinner();
  const stopProbeSpinner = startRotatingSpinner(probeSpinner, [
    "Parsing source repository (branches + metadata)…",
  ]);

  const [sourceBranches, remoteHeadBranch] = await Promise.all([
    listRemoteBranches(sourceCloneUrl).catch(() => []),
    getRemoteHeadBranch(sourceCloneUrl),
  ]);
  const effectiveDefaultBranch = resolveRemoteDefaultBranch(sourceBranches, sourceBranch, remoteHeadBranch);
  const defaultBranchLabel = effectiveDefaultBranch
    ? sourceBranch
      ? effectiveDefaultBranch
      : `${effectiveDefaultBranch} (default)`
    : undefined;
  const currentBranchOption = defaultBranchLabel
    ? {
        value: "current" as const,
        label: `Fast: only ${defaultBranchLabel}`,
        hint: sourceBranch
          ? "Branch from URL or --branch"
          : "Remote default branch when URL has no /tree/… (from git HEAD symref, then main/master)",
      }
    : undefined;
  const [repoSize, commitCount] = await Promise.all([
    getRepoSizeKb(sourceRepo),
    getRepoCommitCount(sourceRepo, effectiveDefaultBranch),
  ]);
  stopProbeSpinner();
  probeSpinner.stop(color.green("Source repository ready"));

  const preflight: RepoPreflight = {
    branchCount: sourceBranches.length,
    ...repoSize,
    ...commitCount,
  };
  let estimatedTransferSizeProbeKb: number | undefined;
  const shouldProbeSizeLater = !preflight.sizeKb;

  let branchScope: BranchScope = "current";
  let selectedBranches: string[] = sourceBranch ? [sourceBranch] : effectiveDefaultBranch ? [effectiveDefaultBranch] : [];
  if (argv.allBranches && argv.currentBranchOnly) {
    p.log.error("Use only one of --all-branches or --current-branch-only");
    process.exit(1);
  }
  if (argv.allBranches) branchScope = "all";
  else if (argv.currentBranchOnly) branchScope = "current";
  else if (!argv.noHistory && sourceBranches.length > 1 && !argv.y) {
    const looksExpensive = allBranchesLooksExpensive(preflight);
    const sizeLabel = preflight.sizeKb ? `${formatSizeKb(preflight.sizeKb)} ${preflight.source ?? "reported"} repo` : "unknown repo size";
    const scope = await promptUntilValue<BranchScope>(() =>
      p.select({
        message: "Which branches should be included?",
        options: [
          currentBranchOption,
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
        ].filter((option) => option != null),
        initialValue: currentBranchOption ? "current" : "specific",
      }),
    );
    branchScope = scope as BranchScope;
    if (branchScope === "specific") {
      const initialPick = selectedBranches.length > 0 ? selectedBranches : effectiveDefaultBranch ? [effectiveDefaultBranch] : [];
      const pickedBranches = await promptUntilValue<string[]>(() =>
        p.multiselect({
          message: "Which branches should be included?",
          options: branchOptions(sourceBranches, effectiveDefaultBranch),
          initialValues: initialPick,
          required: true,
        }),
      );
      selectedBranches = pickedBranches as string[];
    }
  }

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

  let withHistory = true;
  if (argv.noHistory) withHistory = false;
  else if (argv.history || historyDepth) withHistory = true;
  else if (!argv.y) {
    const hist = await promptUntilValue<boolean>(() =>
      p.confirm({
        message: "Preserve full commit history from the source?",
        initialValue: true,
      }),
    );
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
      const historyRoute = await promptUntilValue<"fast" | "limited" | "history">(() =>
        p.select({
          message: "How much source history should be kept?",
          options: [
            { value: "fast" as const, label: "Fast route", hint: "No source commit lineage; one fresh commit" },
            { value: "limited" as const, label: "Limited history", hint: "Keep only the latest N commits" },
            { value: "history" as const, label: "Preserve full history", hint: "Can take a long time" },
          ],
          initialValue: "limited",
        }),
      );
      if (historyRoute === "fast") {
        withHistory = false;
      } else if (historyRoute === "limited") {
        const defaultDepth = preflight.commitCount ? Math.min(1000, preflight.commitCount) : 1000;
        const depth = await promptUntilValue<string>(() =>
          p.text({
            message: "How many recent commits should be kept?",
            placeholder: String(defaultDepth),
            initialValue: String(defaultDepth),
            validate: (value) => (parseCommitDepth(value) ? undefined : "Enter a positive integer"),
          }),
        );
        historyDepth = parseCommitDepth(depth as string);
        withHistory = true;
      } else {
        withHistory = true;
      }
    }
  }

  const allBranchesGuardExpensive = allBranchesLooksExpensive(preflight);
  const sizeLabelForBranches = preflight.sizeKb
    ? `${formatSizeKb(preflight.sizeKb)} ${preflight.source ?? "reported"} repo`
    : "unknown repo size";

  while (branchScope === "all" && allBranchesGuardExpensive && withHistory) {
    p.note(
      `This repo looks expensive to hard fork with every branch.\n` +
        `Branches: ${color.cyan(String(preflight.branchCount))}\n` +
        `Size: ${color.cyan(preflight.sizeKb ? formatSizeKb(preflight.sizeKb) : "unknown")}\n\n` +
        (defaultBranchLabel
          ? `Fast route keeps only ${color.cyan(defaultBranchLabel)} and skips tags.`
          : `Use reconfigure to pick specific branches or continue with all branches.`),
      "Large all-branches clone",
    );
    const route = await promptUntilValue<"current" | "reconfigure" | "all">(() =>
      p.select({
        message: "Continue with all branches, use the fast route, or reconfigure?",
        options: [
          defaultBranchLabel ? { value: "current" as const, label: "Use fast route", hint: "One branch only" } : undefined,
          { value: "reconfigure" as const, label: "Reconfigure", hint: "Adjust history and branches (previous choices as defaults)" },
          { value: "all" as const, label: "Continue with all branches", hint: "Can take a long time" },
        ].filter((option) => option != null),
        initialValue: "reconfigure",
      }),
    );
    if (route === "current") {
      branchScope = "current";
    } else if (route === "all") {
      break;
    } else {
      const historyRoute = await promptUntilValue<"fast" | "limited" | "history">(() =>
        p.select({
          message: "How much source history should be kept?",
          options: [
            { value: "fast" as const, label: "Fast route", hint: "No source commit lineage; one fresh commit" },
            { value: "limited" as const, label: "Limited history", hint: "Keep only the latest N commits" },
            { value: "history" as const, label: "Preserve full history", hint: "Can take a long time" },
          ],
          initialValue: historyDepth ? "limited" : withHistory ? "history" : "fast",
        }),
      );
      if (historyRoute === "fast") {
        withHistory = false;
        historyDepth = undefined;
        branchScope = "current";
        break;
      }
      if (historyRoute === "limited") {
        const defaultDepth = historyDepth ?? (preflight.commitCount ? Math.min(1000, preflight.commitCount) : 1000);
        const depth = await promptUntilValue<string>(() =>
          p.text({
            message: "How many recent commits should be kept?",
            placeholder: String(defaultDepth),
            initialValue: String(defaultDepth),
            validate: (value) => (parseCommitDepth(value) ? undefined : "Enter a positive integer"),
          }),
        );
        historyDepth = parseCommitDepth(depth as string);
        withHistory = true;
      } else {
        historyDepth = undefined;
        withHistory = true;
      }

      const nextScope = await promptUntilValue<BranchScope>(() =>
        p.select({
          message: "Which branches should be included?",
          options: [
            currentBranchOption,
            {
              value: "specific" as const,
              label: "Pick specific branches",
              hint: "Choose one or more branches",
            },
            {
              value: "all" as const,
              label: `All branches (${sourceBranches.length})`,
              hint: `Likely slow: ${sizeLabelForBranches}`,
            },
          ].filter((option) => option != null),
          initialValue: currentBranchOption ? "current" : "specific",
        }),
      );
      branchScope = nextScope as BranchScope;
      if (branchScope === "specific") {
        const pickedBranches = await promptUntilValue<string[]>(() =>
          p.multiselect({
            message: "Which branches should be included?",
            options: branchOptions(sourceBranches, effectiveDefaultBranch),
            initialValues: selectedBranches.length ? selectedBranches : effectiveDefaultBranch ? [effectiveDefaultBranch] : [],
            required: true,
          }),
        );
        selectedBranches = pickedBranches as string[];
      }
    }
  }

  const isMultiBranchNoHistory = () =>
    !withHistory && (branchScope === "all" || (branchScope === "specific" && selectedBranches.length > 1));

  while (isMultiBranchNoHistory()) {
    const branchLabel =
      branchScope === "all" ? `all branches (${sourceBranches.length || preflight.branchCount || "unknown"})` : selectedBranches.join(", ");
    const warning =
      `No-history mode will keep ${color.cyan(branchLabel)}, but each branch becomes its own single fresh root commit.\n\n` +
      `The cloned source refs stay available as ${color.cyan("origin/<branch>")} until origin is pointed at the new remote. ` +
      `Only the local branches pushed to the destination lose source history.`;

    if (argv.y) {
      p.log.warn(warning);
      break;
    }

    p.note(warning, "Multi-branch no-history");
    const next = await promptUntilValue<"continue" | "reconfigure">(() =>
      p.select({
        message: "Continue with multi-branch no-history?",
        options: [
          { value: "continue" as const, label: "Continue", hint: "Collapse each selected branch independently" },
          { value: "reconfigure" as const, label: "Reconfigure", hint: "Change history amount or branches" },
        ],
        initialValue: "continue",
      }),
    );
    if (next === "continue") break;

    const reconfigure = await promptUntilValue<string[]>(() =>
      p.multiselect({
        message: "What do you want to reconfigure?",
        options: [
          { value: "history" as const, label: "History amount", hint: describeHistoryChoice(withHistory, historyDepth) },
          {
            value: "branches" as const,
            label: "Branches",
            hint: branchScope === "all" ? `all branches (${sourceBranches.length})` : selectedBranches.join(", "),
          },
        ],
        initialValues: ["history"],
        required: true,
      }),
    );
    const reconfigureChoices = reconfigure as string[];

    if (reconfigureChoices.includes("history")) {
      const historyRoute = await promptUntilValue<"fast" | "limited" | "history">(() =>
        p.select({
          message: "How much source history should be kept?",
          options: [
            { value: "fast" as const, label: "Fast route", hint: "No source commit lineage; one fresh commit per branch" },
            { value: "limited" as const, label: "Limited history", hint: "Keep only the latest N commits" },
            { value: "history" as const, label: "Preserve full history", hint: "Can take a long time" },
          ],
          initialValue: historyDepth ? "limited" : withHistory ? "history" : "fast",
        }),
      );
      if (historyRoute === "fast") {
        withHistory = false;
        historyDepth = undefined;
      } else if (historyRoute === "limited") {
        const defaultDepth = historyDepth ?? (preflight.commitCount ? Math.min(1000, preflight.commitCount) : 1000);
        const depth = await promptUntilValue<string>(() =>
          p.text({
            message: "How many recent commits should be kept?",
            placeholder: String(defaultDepth),
            initialValue: String(defaultDepth),
            validate: (value) => (parseCommitDepth(value) ? undefined : "Enter a positive integer"),
          }),
        );
        historyDepth = parseCommitDepth(depth as string);
        withHistory = true;
      } else {
        historyDepth = undefined;
        withHistory = true;
      }
    }

    if (reconfigureChoices.includes("branches") && sourceBranches.length > 1) {
      const nextScope = await promptUntilValue<BranchScope>(() =>
        p.select({
          message: "Which branches should be included?",
          options: [
            currentBranchOption,
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
          ].filter((option) => option != null),
          initialValue: currentBranchOption && branchScope === "current" ? "current" : branchScope === "all" ? "all" : "specific",
        }),
      );
      branchScope = nextScope as BranchScope;
      if (branchScope === "specific") {
        const pickedBranches = await promptUntilValue<string[]>(() =>
          p.multiselect({
            message: "Which branches should be included?",
            options: branchOptions(sourceBranches, effectiveDefaultBranch),
            initialValues:
              selectedBranches.length > 0 ? selectedBranches : effectiveDefaultBranch ? [effectiveDefaultBranch] : [],
            required: true,
          }),
        );
        selectedBranches = pickedBranches as string[];
      } else {
        selectedBranches = sourceBranch ? [sourceBranch] : [];
      }
    }
  }

  while (true) {
    if (shouldProbeSizeLater && !preflight.sizeKb && estimatedTransferSizeProbeKb == null) {
      const sizeProbeSpinner = p.spinner();
      const stopSizeProbeSpinner = startRotatingSpinner(sizeProbeSpinner, [
        "Calculating repository sizes (transfer + full checkout)…",
      ]);
      const probedSizes = await probeRemoteSizeEstimatesKb(sourceCloneUrl, effectiveDefaultBranch);
      estimatedTransferSizeProbeKb = probedSizes.transferSizeKb;
      if (probedSizes.fullRepoSizeKb) {
        preflight.sizeKb = probedSizes.fullRepoSizeKb;
        preflight.source = "git probe";
      }
      stopSizeProbeSpinner();
      sizeProbeSpinner.stop(color.green("Repository size estimates ready"));
    }
    const estimatedSizeKb =
      estimatedTransferSizeProbeKb ??
      estimateTransferSizeKb({
        preflight,
        withHistory,
        historyDepth,
        branchScope,
        selectedBranchCount: branchScope === "current" ? 1 : selectedBranches.length,
      });
    const estimatedRepoSizeKb = preflight.sizeKb;
    const branchLabel =
      branchScope === "all"
        ? `all branches (${sourceBranches.length || preflight.branchCount || "unknown"})`
        : branchScope === "specific"
          ? selectedBranches.join(", ")
          : defaultBranchLabel ?? "Git remote HEAD branch";
    const estimateLines = [
      `History: ${color.cyan(describeHistoryChoice(withHistory, historyDepth))}`,
      `Branches: ${color.cyan(branchLabel)}`,
      `Estimated git transfer size: ${color.cyan(estimatedSizeKb ? formatSizeKb(estimatedSizeKb) : "unknown")}`,
      `Estimated full repo size: ${color.dim(estimatedRepoSizeKb ? formatSizeKb(estimatedRepoSizeKb) : "unknown")}`,
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

    const next = await promptUntilValue<"continue" | "reconfigure">(() =>
      p.select({
        message: "Continue with this setup?",
        options: [
          { value: "continue" as const, label: "Continue", hint: "Enter the new repo URL next" },
          { value: "reconfigure" as const, label: "Reconfigure", hint: "Change history amount or branches" },
        ],
        initialValue: "continue",
      }),
    );
    if (next === "continue") break;

    const reconfigure = await promptUntilValue<string[]>(() =>
      p.multiselect({
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
                  : defaultBranchLabel ?? "Git remote HEAD branch",
          },
        ],
        initialValues: ["history"],
        required: true,
      }),
    );
    const reconfigureChoices = reconfigure as string[];

    if (reconfigureChoices.includes("history")) {
      const historyRoute = await promptUntilValue<"fast" | "limited" | "history">(() =>
        p.select({
          message: "How much source history should be kept?",
          options: [
            { value: "fast" as const, label: "Fast route", hint: "No source commit lineage; one fresh commit" },
            { value: "limited" as const, label: "Limited history", hint: "Keep only the latest N commits" },
            { value: "history" as const, label: "Preserve full history", hint: "Can take a long time" },
          ],
          initialValue: historyDepth ? "limited" : withHistory ? "history" : "fast",
        }),
      );
      if (historyRoute === "fast") {
        withHistory = false;
        historyDepth = undefined;
      } else if (historyRoute === "limited") {
        const defaultDepth = historyDepth ?? (preflight.commitCount ? Math.min(1000, preflight.commitCount) : 1000);
        const depth = await promptUntilValue<string>(() =>
          p.text({
            message: "How many recent commits should be kept?",
            placeholder: String(defaultDepth),
            initialValue: String(defaultDepth),
            validate: (value) => (parseCommitDepth(value) ? undefined : "Enter a positive integer"),
          }),
        );
        historyDepth = parseCommitDepth(depth as string);
        withHistory = true;
      } else {
        historyDepth = undefined;
        withHistory = true;
      }
    }

    if (reconfigureChoices.includes("branches") && sourceBranches.length > 1) {
      const nextScope = await promptUntilValue<BranchScope>(() =>
        p.select({
          message: "Which branches should be included?",
          options: [
            currentBranchOption,
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
          ].filter((option) => option != null),
          initialValue: currentBranchOption && branchScope === "current" ? "current" : branchScope === "all" ? "all" : "specific",
        }),
      );
      branchScope = nextScope as BranchScope;
      if (branchScope === "specific") {
        const pickedBranches = await promptUntilValue<string[]>(() =>
          p.multiselect({
            message: "Which branches should be included?",
            options: branchOptions(sourceBranches, effectiveDefaultBranch),
            initialValues:
              selectedBranches.length > 0 ? selectedBranches : effectiveDefaultBranch ? [effectiveDefaultBranch] : [],
            required: true,
          }),
        );
        selectedBranches = pickedBranches as string[];
      } else {
        selectedBranches = sourceBranch ? [sourceBranch] : [];
      }
    }
  }

  let newRemote = argv.remote?.trim();
  if (cloneMode === "temp") {
    if (!newRemote && !argv.y) {
      const r = await promptUntilValue<string>(() =>
        p.text({
          message: "New repository URL (must exist; empty repo recommended)",
          placeholder: "git@github.com:you/fork.git",
          validate: (value) => validateRemoteUrl(value) ?? validateDestinationIsNotSource(sourceCloneUrl, value),
        }),
      );
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
    const link = await promptUntilValue<boolean>(() =>
      p.confirm({
        message: "Point origin at a new remote (your fork repo)?",
        initialValue: true,
      }),
    );
    if (link) {
      const r = await promptUntilValue<string>(() =>
        p.text({
          message: "New remote URL",
          placeholder: "https://github.com/you/fork.git",
          validate: (value) => validateRemoteUrl(value) ?? validateDestinationIsNotSource(sourceCloneUrl, value),
        }),
      );
      newRemote = (r as string).trim();
    }
  }

  while (newRemote) {
    const remErr = validateRemoteUrl(newRemote);
    const sameRemoteErr = validateDestinationIsNotSource(sourceCloneUrl, newRemote);
    if (remErr || sameRemoteErr) {
      p.log.error(remErr ?? sameRemoteErr ?? "Invalid destination remote");
      process.exit(1);
    }

    const access = await assertRemoteAccessWithRecovery({
      remoteUrl: newRemote,
      mode: "write",
      role: "destination",
      changeLabel: "Change destination repo",
      disabled: argv.y,
    });
    if (access === "ok") break;

    const nextRemote = await promptUntilValue<string>(() =>
      p.text({
        message: "New remote URL",
        placeholder: "https://github.com/you/fork.git",
        initialValue: newRemote,
        validate: (value) => validateRemoteUrl(value) ?? validateDestinationIsNotSource(sourceCloneUrl, value),
      }),
    );
    newRemote = (nextRemote as string).trim();
  }

  let shouldPush = false;
  if (cloneMode === "temp") shouldPush = true;
  else if (argv.push && argv.noPush) {
    p.log.error("Use only one of --push or --no-push");
    process.exit(1);
  } else if (argv.noPush) shouldPush = false;
  else if (argv.push) shouldPush = true;
  else if (newRemote && !argv.y) {
    const pushAns = await promptUntilValue<boolean>(() =>
      p.confirm({
        message: "Push to the new remote now?",
        initialValue: true,
      }),
    );
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
      const d = await promptUntilValue<string>(() =>
        p.text({
          message: "Local directory name",
          placeholder: suggested,
          initialValue: suggested,
          validate: validateLocalDir,
        }),
      );
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
    p.log.error(await formatGitFailure(e, { operation: "clone", role: "source", remoteUrl: sourceCloneUrl }));
    if (cloneMode === "temp" && existsSync(localPath)) rmSync(localPath, { recursive: true, force: true });
    process.exit(1);
  }
  const clonedSourceBranches =
    branchScope === "all" ? await listClonedSourceBranches(localPath) : branchScope === "specific" ? selectedBranches : [];

  try {
    if (!withHistory) {
      if (branchScope === "all" || branchScope === "specific") {
        s.start(`Rewriting ${clonedSourceBranches.length} branches as single commits`);
        await collapseRemoteBranchesToSingleCommits(localPath, clonedSourceBranches);
        s.stop(color.green("Branch histories collapsed"));
      } else {
        s.start("Rewriting as a single new commit");
        await collapseToSingleCommit(localPath);
        s.stop(color.green("History collapsed"));
      }
    } else if (historyDepth) {
      s.start("Finalizing limited history");
      await materializeShallowHistory(localPath);
      s.stop(color.green("Limited history finalized"));
    }

    if (newRemote) {
      s.start("Pointing origin at new remote");
      if (!withHistory && (branchScope === "all" || branchScope === "specific")) {
        await preserveSourceRemoteAndSetOrigin(localPath, newRemote);
      } else {
        await setOriginUrl(localPath, newRemote);
      }
      s.stop(color.green("Remote updated"));
    } else {
      p.log.warn("No new remote — origin still references the source. Add one with:");
      p.log.info(`  cd ${relative(process.cwd(), localPath) || "."}`);
      p.log.info("  git remote set-url origin <your-repo-url>");
    }

    if (shouldPush && newRemote && (branchScope === "all" || branchScope === "specific")) {
      const remoteBranches = await listRemoteBranches(newRemote).catch(() => []);
      const selectedBranchSet = new Set(clonedSourceBranches);
      const destinationOnlyBranches = remoteBranches.filter((branch) => !selectedBranchSet.has(branch));
      let forcePushBranches = false;
      let deleteDestinationOnlyBranches = false;

      if (remoteBranches.length > 0) {
        if (argv.y) {
          p.log.error("Destination repo is not empty.");
          p.log.info(`Existing branches: ${remoteBranches.join(", ")}`);
          p.log.info(`Branches to push: ${clonedSourceBranches.join(", ")}`);
          p.log.info("Rerun without -y to choose whether to keep or nuke destination branches.");
          process.exit(1);
        }

        const destinationSummary = [
          `Remote: ${color.cyan(newRemote)}`,
          `Existing branches: ${color.cyan(remoteBranches.join(", "))}`,
          `Branches to push: ${color.cyan(clonedSourceBranches.join(", "))}`,
          destinationOnlyBranches.length
            ? `Destination-only branches: ${color.yellow(destinationOnlyBranches.join(", "))}`
            : undefined,
        ]
          .filter(Boolean)
          .join("\n");
        p.note(destinationSummary, "Destination is not empty");

        while (true) {
          const destinationAction = await promptUntilValue<"keep" | "nuke" | "abort">(() =>
            p.select({
              message: "How should existing destination branches be handled?",
              options: [
                {
                  value: "keep" as const,
                  label: "Keep destination branches",
                  hint: "Push selected branches; unrelated destination branches remain",
                },
                {
                  value: "nuke" as const,
                  label: "Nuke destination repo branches",
                  hint: "Force-push selected branches and delete destination-only branches",
                },
                { value: "abort" as const, label: "Abort", hint: "Leave destination unchanged" },
              ],
              initialValue: destinationOnlyBranches.length > 0 ? "nuke" : "keep",
            }),
          );

          if (destinationAction === "abort") exitCancelled("Push aborted");
          if (destinationAction === "keep") break;

          p.note(
            `${color.bold("This is NOT reversible.")}\n` +
              `Remote: ${color.cyan(newRemote)}\n` +
              `Force-push branches: ${color.cyan(clonedSourceBranches.join(", "))}\n` +
              `Delete branches (${destinationOnlyBranches.length}): ${color.cyan(destinationOnlyBranches.join(", ") || "(none)")}`,
            "Confirm nuke destination",
          );
          const confirmNuke = await promptUntilValue<"proceed" | "reconfigure" | "abort">(() =>
            p.select({
              message: "Proceed with nuking destination branches?",
              options: [
                { value: "proceed" as const, label: "Proceed", hint: "Force-push selected branches and delete destination-only branches" },
                { value: "reconfigure" as const, label: "Reconfigure", hint: "Go back to destination branch handling options" },
                { value: "abort" as const, label: "Abort", hint: "Leave destination unchanged" },
              ],
              initialValue: "reconfigure",
            }),
          );
          if (confirmNuke === "abort") exitCancelled("Push aborted");
          if (confirmNuke === "reconfigure") continue;

          forcePushBranches = true;
          deleteDestinationOnlyBranches = true;
          break;
        }
      }

      s.start(`${forcePushBranches ? "Force-pushing" : "Pushing"} ${clonedSourceBranches.length} branches to origin`);
      if (withHistory) {
        await pushClonedSourceBranches(localPath, clonedSourceBranches, forcePushBranches);
      } else {
        await pushLocalBranches(localPath, clonedSourceBranches, forcePushBranches);
      }
      s.stop(color.green(forcePushBranches ? "Force-pushed branches" : "Pushed branches"));

      if (deleteDestinationOnlyBranches && destinationOnlyBranches.length > 0) {
        s.start(`Deleting ${destinationOnlyBranches.length} destination branches`);
        for (const branch of destinationOnlyBranches) {
          try {
            await deleteRemoteBranch(localPath, branch);
          } catch {
            p.log.warn(`Could not delete remote branch: ${branch}`);
          }
        }
        s.stop(color.green("Deleted destination branches"));
      }
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
          const picked = await promptUntilValue<string>(() =>
            p.select({
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
            }),
          );
          if (picked === "__nuke_all__") {
            const primaryDefault = preferredDefaultBranch(
              remoteBranches.filter((b) => b === "main" || b === "master"),
              "main",
            );
            const primaryPicked = await promptUntilValue<"main" | "master">(() =>
              p.select({
                message: "Primary branch for the new push",
                options: [
                  { value: "main", label: "main" },
                  { value: "master", label: "master" },
                ],
                initialValue: primaryDefault === "master" ? "master" : "main",
              }),
            );
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
            const ok = await promptUntilValue<boolean>(() =>
              p.confirm({
                message: "Proceed with nuking all branches on destination?",
                initialValue: false,
              }),
            );
            if (!ok) exitCancelled("Nuke-all aborted");

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
          const resolution = await promptUntilValue<"preserve" | "force">(() =>
            p.select({
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
            }),
          );

          if (resolution === "force") {
            p.note(
              `${color.bold("This is NOT reversible.")}\n` +
                `Remote: ${color.cyan(newRemote)}\n` +
                `Branch: ${color.cyan(targetBranch)}\n` +
                `Action: ${color.cyan("force-push overwrite")}`,
              "Confirm force overwrite",
            );
            const ok = await promptUntilValue<boolean>(() =>
              p.confirm({
                message: "Proceed with force-pushing and overwriting remote history?",
                initialValue: false,
              }),
            );
            if (!ok) exitCancelled("Push aborted");

            s.start(`Force-pushing ${targetBranch} to origin`);
            await forcePushHeadToBranch(localPath, targetBranch);
            s.stop(color.green("Force-pushed"));
          } else {
            const preserveMode = await promptUntilValue<"single-commit" | "replay-source-history">(() =>
              p.select({
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
              }),
            );

            if (preserveMode === "single-commit") {
              const defaultPreserveCommitMessage = `Hardfork: replaced with files from ${source}`;
              const msg = await promptUntilValue<string>(() =>
                p.text({
                  message: "Commit message (on top of the remote history)",
                  placeholder: defaultPreserveCommitMessage,
                  initialValue: defaultPreserveCommitMessage,
                  validate: (v) => (!v?.trim() ? "Commit message is required" : undefined),
                }),
              );

              s.start(`Preserving remote history on ${targetBranch}`);
              await preserveRemoteHistoryButReplaceFiles({
                repoCwd: localPath,
                branch: targetBranch,
                commitMessage: (msg as string).trim(),
              });
              s.stop(color.green("Pushed (history preserved via single commit)"));
            } else {
              const cleanupMsg = await promptUntilValue<string>(() =>
                p.text({
                  message: "Cleanup commit message (separates destination history)",
                  placeholder: "Hardfork: cleanup before replaying source history",
                  initialValue: "Hardfork: cleanup before replaying source history",
                  validate: (v) => (!v?.trim() ? "Cleanup commit message is required" : undefined),
                }),
              );

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
    p.log.error(await formatGitFailure(e, { operation: "git", role: newRemote ? "destination" : "local", remoteUrl: newRemote }));
    if (cloneMode === "temp" && existsSync(localPath)) rmSync(localPath, { recursive: true, force: true });
    process.exit(1);
  }

  if (cloneMode === "temp") {
    s.start("Removing temporary clone");
    rmSync(localPath, { recursive: true, force: true });
    s.stop(color.green("Temporary clone removed"));
    p.note(`${color.cyan(newRemote ?? "")}\nYour repo now has the forked content.`, "Done");
  } else {
    const doneLines = [
      `cd ${formatLocalPathLink(localPath)}`,
      `Origin repo: ${formatRepoLink(sourceCloneUrl)}`,
      newRemote ? `Destination repo: ${formatRepoLink(newRemote)}` : `Destination repo: ${color.dim("not configured")}`,
    ].join("\n");
    p.note(doneLines, "Done");
  }

  p.outro(color.green("hardfork complete"));
}
