export type SourceRepo = {
  cloneUrl: string;
  branch?: string;
  host?: "github" | "gitlab";
  owner?: string;
  repo?: string;
};

export type RepoPreflight = {
  branchCount: number;
  sizeKb?: number;
  commitCount?: number;
  source?: string;
};

export type CloneMode = "temp" | "normal";
export type BranchScope = "current" | "specific" | "all";
export type NukeMode = "preserve" | "wipe";

export interface ParsedArgv {
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

export interface NukeArgv {
  repo?: string;
  preserveHistory?: boolean;
  wipeHistory?: boolean;
  branch?: string;
  defaultBranch?: string;
  allBranches?: boolean;
  branchesOnly?: boolean;
  message?: string;
  y: boolean;
  _: (string | number)[];
}

export interface RevertArgv {
  repo?: string;
  commit?: string;
  branch?: string;
  keepHistory?: boolean;
  destructive?: boolean;
  y: boolean;
  _: (string | number)[];
}

export type ExecaLikeError = {
  code?: string;
  shortMessage?: string;
  message?: string;
  stderr?: string;
  stdout?: string;
  all?: string;
};
