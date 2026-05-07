import * as p from "@clack/prompts";

let abortRequested = false;
let answeredPromptCount = 0;

const MIN_PROMPTS_BEFORE_ABORT_CONFIRMATION = 2;
const ABORT_WARNING = "This will cancel every config you've selected so far.";

export const exitCancelled = (message = "Cancelled"): never => {
  p.cancel(message);
  process.exit(0);
  throw new Error(message);
};

export async function confirmAbort(message = "Abort operation?"): Promise<boolean> {
  if (answeredPromptCount < MIN_PROMPTS_BEFORE_ABORT_CONFIRMATION) exitCancelled("Cancelled");
  if (abortRequested) exitCancelled("Cancelled");
  abortRequested = true;

  p.note(ABORT_WARNING, "Heads up");
  const shouldAbort = await p.confirm({
    message,
    active: "yes",
    inactive: "no, continue",
    initialValue: false,
  });

  if (p.isCancel(shouldAbort) || shouldAbort) exitCancelled("Cancelled");
  abortRequested = false;
  return false;
}

export async function promptUntilValue<T>(prompt: () => Promise<T | symbol>, abortMessage?: string): Promise<T> {
  while (true) {
    const value = await prompt();
    if (!p.isCancel(value)) {
      answeredPromptCount += 1;
      return value as T;
    }
    await confirmAbort(abortMessage);
  }
}

export function installCtrlCAbortHandler(): void {
  process.on("SIGINT", () => {
    if (answeredPromptCount < MIN_PROMPTS_BEFORE_ABORT_CONFIRMATION) exitCancelled("Cancelled");
    if (abortRequested) exitCancelled("Cancelled");

    abortRequested = true;
    void (async () => {
      p.note(ABORT_WARNING, "Heads up");
      const shouldAbort = await p.confirm({
        message: "Abort operation?",
        active: "yes",
        inactive: "no, continue",
        initialValue: false,
      });

      if (p.isCancel(shouldAbort) || shouldAbort) exitCancelled("Cancelled");
      abortRequested = false;
    })();
  });
}
