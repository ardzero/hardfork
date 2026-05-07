import * as p from "@clack/prompts";

export const exitCancelled = (message = "Cancelled"): never => {
  p.cancel(message);
  process.exit(0);
};
