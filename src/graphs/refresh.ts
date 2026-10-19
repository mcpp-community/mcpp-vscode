/** Event bursts coalesce into one cancellable query and at most one pending rerun. */
export class RefreshCoordinator {
  private timer?: ReturnType<typeof setTimeout>;
  private started = 0;
  private dirty = false;
  private flight?: Promise<void>;
  private controller?: AbortController;
  private disposed = false;
  public visible = true;
  public constructor(private readonly refresh: (signal: AbortSignal) => Promise<void>, private readonly delay = 200, private readonly maxWait = 1000) {}
  public request(immediate = false): Promise<void> {
    if (this.disposed) { return Promise.resolve(); }
    this.dirty = true;
    if (!this.visible) { return Promise.resolve(); }
    if (this.flight) { return this.flight; }
    if (!this.started) { this.started = Date.now(); }
    if (this.timer) { clearTimeout(this.timer); }
    if (immediate) { return this.run(); }
    this.timer = setTimeout(() => { void this.run(); }, Math.min(this.delay, Math.max(0, this.maxWait - (Date.now() - this.started))));
    return Promise.resolve();
  }
  public setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible && this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (visible && this.dirty) { void this.request(true); }
  }
  private run(): Promise<void> {
    if (this.flight || this.disposed || !this.visible) { return this.flight ?? Promise.resolve(); }
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.started = 0; this.dirty = false;
    const controller = new AbortController(); this.controller = controller;
    this.flight = Promise.resolve().then(() => this.refresh(controller.signal)).finally(() => {
      this.flight = undefined;
      if (this.controller === controller) { this.controller = undefined; }
      if (this.dirty && !this.disposed && this.visible) { void this.request(); }
    });
    return this.flight;
  }
  public cancel(): void {
    this.controller?.abort(); this.dirty = false; this.started = 0;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
  }
  public dispose(): void { this.disposed = true; this.cancel(); }
}
