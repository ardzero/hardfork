import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Works from `src/**`, bundled `dist/cli.js`, or tests — walks up to repo `package.json`. */
export function getVersion(): string {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 10; i++) {
      try {
        const pkgPath = resolve(dir, "package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
        if (pkg.version) return pkg.version;
      } catch {
        /* continue */
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* fall through */
  }
  return "0.0.1";
}
