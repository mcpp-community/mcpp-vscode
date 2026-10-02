/**
 * One place that decides whether a line reaches the `mcpp` output channel.
 *
 * `mcpp.log.level` is a **threshold**, not a filter list: `error` writes only
 * errors, `warn` adds warnings, `info` is the declared default, and `debug`
 * writes everything. Two rules keep the channel honest:
 *
 * - an error is never suppressed by any configured level — that is why a failed
 *   command's raw stdout/stderr is written at `error` by its caller;
 * - an unknown configured value degrades to the default instead of silencing
 *   the channel, and an unknown line level is treated as the most verbose thing
 *   it could be.
 *
 * Pure and `vscode`-free: `createLogger` takes any `appendLine`-shaped sink and
 * a level callback, so the policy can be asserted without an editor.
 */

export type LogLevel = "error" | "warn" | "info" | "debug";

const ORDER: Readonly<Record<LogLevel, number>> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const DEFAULT_LEVEL: LogLevel = "info";

export function isLogLevel(value: unknown): value is LogLevel {
  return value === "error" || value === "warn" || value === "info" || value === "debug";
}

/** Coerce a configured value: anything unknown becomes the declared default. */
export function logLevelOf(value: unknown): LogLevel {
  return isLogLevel(value) ? value : DEFAULT_LEVEL;
}

/**
 * True when a line at `level` should be written while `configured` is the
 * effective `mcpp.log.level`. An error passes at every level.
 */
export function shouldLog(level: LogLevel, configured: unknown): boolean {
  const threshold = ORDER[logLevelOf(configured)];
  const wanted = ORDER[isLogLevel(level) ? level : "debug"];
  return wanted <= threshold;
}

/** The part of an `OutputChannel` this module needs. */
export interface LogChannel {
  appendLine(line: string): unknown;
}

export interface Logger {
  error(line: string): void;
  warn(line: string): void;
  info(line: string): void;
  debug(line: string): void;
}

/**
 * A levelled writer over an output channel. The level is read per line, so a
 * configuration change applies to the next line without re-creating the logger.
 * A channel that has already been disposed is a no-op, never a crash.
 */
export function createLogger(channel: LogChannel, levelOf: () => unknown): Logger {
  const write = (level: LogLevel, line: string): void => {
    if (!shouldLog(level, levelOf())) {
      return;
    }
    try {
      channel.appendLine(line);
    } catch {
      // The output channel can be released during a window reload or shutdown.
    }
  };
  return {
    error: (line) => write("error", line),
    warn: (line) => write("warn", line),
    info: (line) => write("info", line),
    debug: (line) => write("debug", line),
  };
}
