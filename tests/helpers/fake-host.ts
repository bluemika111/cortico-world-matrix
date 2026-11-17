/** World 测试共用的假宿主：记录推送的事件与投递口径，其余接口是空实现。 */
import type { EventEnvelope, PushOptions, WorldHost } from 'cortico/core/types.ts';

export class FakeHost implements WorldHost {
  events: EventEnvelope[] = [];
  /** 与 events 逐条对齐，唤醒与合批的口径也要能断言。 */
  pushOpts: Array<PushOptions | undefined> = [];
  private readonly accepts: (mime: string) => boolean;

  constructor(options: { accepts?: (mime: string) => boolean } = {}) {
    this.accepts = options.accepts ?? (() => false);
  }

  pushDeferred(): void {}
  store = {
    get: () => undefined,
    latestCursor: () => 0,
    range: () => [],
    around: () => [],
    grep: () => [],
  } as unknown as WorldHost['store'];
  blob = (): { bytes: Uint8Array; mime: string } | null => null;
  modelFacts = {
    model: () => 'test',
    accepts: (mime: string) => this.accepts(mime),
    contextWindow: () => 128000,
  } as unknown as WorldHost['modelFacts'];
  log = {
    child() {
      return this;
    },
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    emit() {},
  } as unknown as WorldHost['log'];

  async pushEvent(e: Omit<EventEnvelope, 'cursor'>, opts?: PushOptions): Promise<EventEnvelope> {
    const full = { ...e, cursor: this.events.length + 1 } as EventEnvelope;
    this.events.push(full);
    this.pushOpts.push(opts);
    return full;
  }

  async drainPendingEvents(): Promise<EventEnvelope[]> {
    return [];
  }

  reportUsage(): void {}

  /** 某种事件的全部正文，断言用。 */
  texts(type: string): string[] {
    return this.events.filter((event) => event.type === type).map((event) => event.text);
  }
}
