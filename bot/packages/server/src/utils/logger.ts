/**
 * Lightweight structured logger with levels and module prefixes.
 *
 * Output format: `2026-03-15T12:00:00.000Z INFO  [ssh] Connected to Server A`
 * LOG_LEVEL read from process.env directly (logger loads before Zod env validation).
 * error/warn → stderr (journald priority 3-4); info/debug → stdout (priority 6).
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

function getLevel(): number {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return LEVELS[raw as Level] ?? LEVELS.info;
}

let currentLevel = getLevel();

function log(level: Level, module: string, msg: string, extra?: unknown): void {
  if (LEVELS[level] < currentLevel) return;
  const ts = new Date().toISOString();
  const tag = level.toUpperCase().padEnd(5);
  const line = `${ts} ${tag} [${module}] ${msg}`;
  const write = level === "error" || level === "warn" ? console.error : console.log;
  if (extra !== undefined) {
    write(line, extra);
  } else {
    write(line);
  }
}

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

export function createLogger(module: string): Logger {
  return {
    debug: (msg, extra?) => log("debug", module, msg, extra),
    info: (msg, extra?) => log("info", module, msg, extra),
    warn: (msg, extra?) => log("warn", module, msg, extra),
    error: (msg, extra?) => log("error", module, msg, extra),
  };
}

/** Reload level at runtime (e.g. after env validation confirms the value). */
export function reloadLogLevel(): void {
  currentLevel = getLevel();
}

/**
 * Returns a catch handler that logs the error instead of swallowing it.
 * Replaces `.catch(() => {})` patterns.
 *
 * Usage: somePromise.catch(logOnError(logger, "context description"))
 */
export function logOnError(logger: Logger, context: string): (err: unknown) => void {
  return (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`${context}: ${msg}`);
  };
}
