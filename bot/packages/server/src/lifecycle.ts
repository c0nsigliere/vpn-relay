/**
 * Process teardown registry.
 *
 * The shutdown sequence used to be a closure in index.ts over `bot`, `apiServer` and
 * `workers`. That works for signal handling, but a bot-driven restore has to run the
 * same sequence from inside a service — and a service cannot import index.ts without
 * a cycle. So the steps are registered here instead, and both paths call runTeardown().
 *
 * Every step is individually try/caught: a hung bot.stop() must not strand db.close(),
 * because an unclosed database leaves a WAL behind and the whole point of the restore
 * path is to swap a clean file into place.
 *
 * Imports nothing but the logger — that is what keeps it cycle-free.
 */

import { createLogger } from "./utils/logger";

const logger = createLogger("lifecycle");

interface Step {
  name: string;
  run: () => unknown | Promise<unknown>;
}

const steps: Step[] = [];
let torndown = false;

export function onTeardown(name: string, run: Step["run"]): void {
  steps.push({ name, run });
}

/**
 * Run every registered step in registration order. Idempotent: a second SIGTERM
 * arriving mid-shutdown is a no-op rather than a double-close of every resource.
 */
export async function runTeardown(): Promise<void> {
  if (torndown) return;
  torndown = true;
  for (const step of steps) {
    try {
      await step.run();
    } catch (err) {
      logger.error(`teardown step "${step.name}" failed`, err);
    }
  }
  logger.info("Teardown complete");
}

export function isTornDown(): boolean {
  return torndown;
}

/**
 * Bound a teardown so a network round-trip that never returns (bot.stop() commits the
 * update offset to Telegram) cannot hang the process forever. Resolves either way —
 * the caller decides what to do next.
 */
export async function runTeardownWithTimeout(ms: number): Promise<void> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      logger.warn(`Teardown exceeded ${ms}ms — continuing anyway`);
      resolve();
    }, ms);
  });
  await Promise.race([runTeardown(), deadline]);
  clearTimeout(timer!);
}
