/**
 * The one interval timer two views share.
 *
 * Both `mcpp.cache.autoRefreshSeconds` and
 * `mcpp.languageService.stateRefreshSeconds` mean the same thing: re-read while
 * the view is visible, stop when it is not, and never let a second read overlap
 * one that is still running. Keeping the mechanism here — free of `vscode`, so
 * `node:test` can drive it with a fake clock — means the two call sites own only
 * the decision of *what* to refresh.
 *
 * The caller disposes the timer with the extension; `dispose()` is idempotent.
 */

export interface PollTimerOptions {
  periodMs: number;
  /** The refresh itself. Runs between ticks; the timer never awaits it. */
  tick: () => void;
  /** Injected for tests; defaults to `setInterval`/`clearInterval`. */
  setIntervalFn?: (handler: () => void, periodMs: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

export class PollTimer {
  private readonly setIntervalFn: (handler: () => void, periodMs: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;
  private handle: unknown;
  private periodMs: number;

  public constructor(private readonly options: PollTimerOptions) {
    this.setIntervalFn =
      options.setIntervalFn ?? ((handler, periodMs) => setInterval(handler, periodMs));
    this.clearIntervalFn = options.clearIntervalFn ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
    this.periodMs = options.periodMs;
  }

  /** True while a period is armed, so the caller can assert it did not leak. */
  public get active(): boolean {
    return this.handle !== undefined;
  }

  /** The period currently armed, in milliseconds. */
  public get period(): number {
    return this.periodMs;
  }

  /**
   * Arm, re-arm or stop. A non-positive or unreadable period stops the timer, so
   * "0 = off" holds no matter what the settings file contains.
   */
  public start(periodMs: number): void {
    this.periodMs = periodMs;
    this.stop();
    if (!Number.isFinite(periodMs) || periodMs <= 0) {
      return;
    }
    this.handle = this.setIntervalFn(() => {
      try {
        this.options.tick();
      } catch {
        // A refresh that throws must not kill the timer or the host.
      }
    }, periodMs);
  }

  public stop(): void {
    if (this.handle === undefined) {
      return;
    }
    try {
      this.clearIntervalFn(this.handle);
    } catch {
      // Already cleared, or the host is shutting down.
    }
    this.handle = undefined;
  }

  public dispose(): void {
    this.stop();
  }
}
