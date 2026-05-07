import type { BranchScope, RepoPreflight, SourceRepo } from "@/lib/types.ts";
import { GIT_USER_AGENT } from "@/lib/constants.ts";

export function repoSlugFromUrl(url: string): string {
  const stripped = url.trim().replace(/\.git$/i, "");
  const part = stripped.split(/[/:]/).pop()?.replace(/\.git$/i, "") ?? "repo";
  return part || "repo";
}

export function parseSourceRepo(input: string): SourceRepo {
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

export async function getRepoSizeKb(source: SourceRepo): Promise<{ sizeKb?: number; source?: string }> {
  if (!source.owner || !source.repo) return {};
  try {
    if (source.host === "github") {
      const res = await fetch(`https://api.github.com/repos/${source.owner}/${source.repo}`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": GIT_USER_AGENT },
      });
      if (!res.ok) return {};
      const data = (await res.json()) as { size?: unknown };
      return typeof data.size === "number" ? { sizeKb: data.size, source: "GitHub" } : {};
    }
    if (source.host === "gitlab") {
      const project = encodeURIComponent(`${source.owner}/${source.repo}`);
      const res = await fetch(`https://gitlab.com/api/v4/projects/${project}`, {
        headers: { "User-Agent": GIT_USER_AGENT },
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

export async function getRepoCommitCount(source: SourceRepo, branch?: string): Promise<{ commitCount?: number }> {
  if (!source.owner || !source.repo) return {};
  try {
    if (source.host === "github") {
      const url = new URL(`https://api.github.com/repos/${source.owner}/${source.repo}/commits`);
      url.searchParams.set("per_page", "1");
      if (branch) url.searchParams.set("sha", branch);
      const res = await fetch(url, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": GIT_USER_AGENT },
      });
      if (!res.ok) return {};
      return { commitCount: parseLastPageFromLinkHeader(res.headers.get("link")) };
    }
    if (source.host === "gitlab") {
      const project = encodeURIComponent(`${source.owner}/${source.repo}`);
      const url = new URL(`https://gitlab.com/api/v4/projects/${project}/repository/commits`);
      url.searchParams.set("per_page", "1");
      if (branch) url.searchParams.set("ref_name", branch);
      const res = await fetch(url, { headers: { "User-Agent": GIT_USER_AGENT } });
      if (!res.ok) return {};
      const total = Number(res.headers.get("x-total"));
      return Number.isFinite(total) && total > 0 ? { commitCount: total } : {};
    }
  } catch {
    return {};
  }
  return {};
}

export function formatSizeKb(sizeKb: number): string {
  if (sizeKb >= 1024 * 1024) return `${(sizeKb / 1024 / 1024).toFixed(1)} GB`;
  if (sizeKb >= 1024) return `${(sizeKb / 1024).toFixed(1)} MB`;
  return `${sizeKb} KB`;
}

export function allBranchesLooksExpensive(preflight: RepoPreflight): boolean {
  const sizeKb = preflight.sizeKb ?? 0;
  return preflight.branchCount > 20 || sizeKb > 500 * 1024;
}

export function fullHistoryLooksExpensive(preflight: RepoPreflight): boolean {
  const sizeKb = preflight.sizeKb ?? 0;
  const commitCount = preflight.commitCount ?? 0;
  return commitCount > 3000 || sizeKb > 500 * 1024;
}

export function parseCommitDepth(value: string | number | undefined): number | undefined {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function estimateTransferSizeKb(params: {
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

export function describeHistoryChoice(withHistory: boolean, historyDepth?: number): string {
  if (!withHistory) return "single fresh commit";
  if (historyDepth) return `latest ${historyDepth.toLocaleString()} commits`;
  return "full history";
}

export function branchOptions(sourceBranches: string[], sourceBranch?: string): { value: string; label: string }[] {
  const ordered = sourceBranch
    ? [sourceBranch, ...sourceBranches.filter((branch) => branch !== sourceBranch)]
    : sourceBranches;
  return ordered.map((branch) => ({ value: branch, label: branch }));
}
