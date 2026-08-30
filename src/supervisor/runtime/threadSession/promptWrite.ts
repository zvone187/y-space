import { setTimeout as sleep } from "node:timers/promises";
import type { IPty } from "node-pty";
import type { ProjectLocation } from "@/shared/contracts";

export async function writeSubmittedPrompt(
  pty: Pick<IPty, "write">,
  chunks: readonly string[],
  _projectLocation: ProjectLocation,
  shouldContinue: () => boolean = () => true,
): Promise<boolean> {
  for (const chunk of chunks) {
    if (!shouldContinue()) return false;

    const waitMatch = chunk.match(/^@wait:(\d+)$/);
    if (waitMatch) {
      await sleep(Number(waitMatch[1]));
      if (!shouldContinue()) return false;
      continue;
    }
    pty.write(chunk);
    await sleep(8);
    if (!shouldContinue()) return false;
  }
  return true;
}
