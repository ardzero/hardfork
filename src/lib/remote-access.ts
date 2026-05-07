import * as p from "@clack/prompts";
import color from "picocolors";
import { assertRemoteAccess, formatGitFailure, type RemoteAccessMode } from "@/lib/git.ts";
import { promptUntilValue } from "@/lib/prompts-util.ts";

type RemoteAccessRole = "source" | "destination";

async function recoverRemoteAccess(params: {
  error: unknown;
  mode: RemoteAccessMode;
  role: RemoteAccessRole;
  remoteUrl: string;
  changeLabel: string;
  disabled: boolean;
}): Promise<"change-url" | "retry"> {
  p.log.error(
    await formatGitFailure(params.error, {
      operation: params.mode === "write" ? "push" : "fetch",
      role: params.role,
      remoteUrl: params.remoteUrl,
    }),
  );

  if (params.disabled) process.exit(1);

  const action = await promptUntilValue<"change-url" | "retry" | "change-account">(() =>
    p.select({
      message: "How do you want to fix repository access?",
      options: [
        { value: "change-url" as const, label: params.changeLabel },
        { value: "retry" as const, label: "Try now", hint: "Retry with the current URL/account" },
        { value: "change-account" as const, label: "Change user account", hint: "Switch GitHub/GitLab auth, then retry" },
      ],
      initialValue: "change-url",
    }),
  );

  if (action === "change-account") {
    p.note(
      `Switch the account used by Git, then retry here.\n\n` +
        `GitHub CLI: ${color.cyan("gh auth login")} or ${color.cyan("gh auth switch")}\n` +
        `SSH users: update your SSH key/agent for this host.\n` +
        `HTTPS users: refresh the stored credential/token for this host.`,
      "Change account",
    );
    await promptUntilValue<boolean>(() =>
      p.confirm({
        message: "Ready to retry access with the updated account?",
        initialValue: true,
      }),
    );
    return "retry";
  }

  return action;
}

export async function assertRemoteAccessWithRecovery(params: {
  remoteUrl: string;
  mode: RemoteAccessMode;
  role: RemoteAccessRole;
  changeLabel: string;
  disabled: boolean;
}): Promise<"ok" | "change-url"> {
  while (true) {
    try {
      await assertRemoteAccess(params.remoteUrl, params.mode);
      return "ok";
    } catch (error) {
      const next = await recoverRemoteAccess({ ...params, error });
      if (next === "change-url") return "change-url";
    }
  }
}
