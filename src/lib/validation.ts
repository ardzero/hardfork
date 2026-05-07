import { basename, resolve } from "node:path";
import { existsSync } from "node:fs";

export function validateSourceUrl(value: string | undefined): string | undefined {
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

export function validateRemoteUrl(value: string | undefined): string | undefined {
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

export function validateCommitHash(value: string | undefined): string | undefined {
  if (value == null || !value.trim()) return "Commit hash is required";
  const v = value.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(v)) return "Commit hash must be 7-40 hex characters";
  return undefined;
}

export function validateLocalDir(name: string | undefined): string | undefined {
  if (name == null || !name.trim()) return "Directory name is required";
  const baseName = basename(name.trim());
  if (!baseName || baseName === "." || baseName === "..") return "Invalid directory name";
  const target = resolve(process.cwd(), name.trim());
  if (existsSync(target)) return `Path already exists: ${name.trim()}`;
  return undefined;
}
