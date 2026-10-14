import type { CampfireOpener, DesktopStudySettings, DesktopStudyState } from '@sb/shared';
type Generate = (exclude: string[], signal: AbortSignal) => Promise<CampfireOpener>;
/** Host ticks wake throttled WebViews. Wall-clock deadlines never queue missed intervals. */
export class StudyClock {
  private nextAt: number | null = null;
  private question: CampfireOpener | null = null;
  private awaiting = false;
  private controller: AbortController | null = null;
  private exclude: string[] = [];
  private error = '';
  private retryAt = 0;
  private source = '';
  constructor(private settings: DesktopStudySettings, private generate: Generate,
    private sourceVersion: () => string, private now: () => number = Date.now) {
    this.nextAt = settings.enabled ? this.now() + this.interval() : null;
  }
  configure(settings: DesktopStudySettings): void {
    this.cancel(); this.question = null; this.awaiting = false; this.error = ''; this.retryAt = 0;
    this.settings = settings; this.nextAt = settings.enabled ? this.now() + this.interval() : null;
  }
  tick(eligible: boolean): DesktopStudyState {
    if (!this.settings.enabled || !eligible) return this.state();
    const source = this.sourceVersion();
    if (!this.awaiting && this.source !== source) {
      const changed = this.source !== '';
      this.cancel(); this.question = null; this.retryAt = changed ? this.now() + 15_000 : 0; this.source = source;
    }
    if (this.settings.scope !== 'learning' && !source && !this.awaiting) {
      this.cancel(); this.question = null; this.error = this.settings.scope === 'bilibili'
        ? '等待你启用 B站学习并选择有字幕 / 笔记的学习视频' : '等待你在浏览器选择一个共读网页'; return this.state();
    }
    if (!this.awaiting && !this.question && !this.controller && this.now() >= this.retryAt) this.prepare();
    if (this.question && !this.awaiting && this.now() >= (this.nextAt ?? Infinity)) {
      this.awaiting = true; this.nextAt = null;
    }
    return this.state();
  }
  dismiss(action: 'done' | 'skip' | 'snooze'): void {
    if (this.question) this.exclude = [...this.exclude, this.question.question.question].slice(-12);
    this.cancel(); this.question = null; this.awaiting = false; this.error = ''; this.retryAt = 0;
    this.nextAt = this.settings.enabled ? this.now() + (action === 'snooze' ? 120_000 : this.interval()) : null;
  }
  state(): DesktopStudyState {
    return { settings: { ...this.settings }, nextAt: this.nextAt, preparing: !!this.controller,
      awaiting: this.awaiting, question: this.awaiting ? this.question : null, error: this.error };
  }
  private interval(): number { return this.settings.intervalMinutes * 60_000; }
  private cancel(): void { this.controller?.abort(); this.controller = null; }
  private prepare(): void {
    const controller = new AbortController(); this.controller = controller; this.error = '';
    const source = this.source;
    void this.generate(this.exclude, controller.signal).then(question => {
      if (this.controller !== controller || controller.signal.aborted || source !== this.sourceVersion()) return;
      this.question = question;
    }).catch((error: unknown) => {
      if (this.controller !== controller || controller.signal.aborted) return;
      this.error = error instanceof Error ? error.message : '这次没能备好新题，下个间隔重试';
      this.retryAt = this.now() + this.interval();
      this.nextAt = this.retryAt;
    }).finally(() => { if (this.controller === controller) this.controller = null; });
  }
}
