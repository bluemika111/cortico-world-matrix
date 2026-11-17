import { describe, expect, it } from 'vitest';
import { emptyCounter, evaluateProactive, markFired, rollCounter, type ProactiveInput } from '../src/proactive.ts';

const NOW = Date.parse('2026-11-16T20:00:00+08:00');
const MINUTE = 60_000;
const ROOM = '!room:example.org';

function input(overrides: Partial<ProactiveInput> = {}): ProactiveInput {
  return {
    now: NOW,
    timezone: 'Asia/Shanghai',
    activeFrom: '09:00',
    activeTo: '23:30',
    quietMinutes: 90,
    minIntervalMinutes: 120,
    chance: 1,
    maxPerDay: 6,
    countToday: 0,
    candidates: [{ roomId: ROOM, name: 'Coo', lastActivityAt: NOW - 200 * MINUTE, lastFiredAt: 0 }],
    lastFiredAt: 0,
    random: 0,
    ...overrides,
  };
}

describe('evaluateProactive', () => {
  it('安静够久、在时段内、概率过了就开口', () => {
    const decision = evaluateProactive(input());
    expect(decision.fire).toBe(true);
    if (!decision.fire) return;
    expect(decision.target.roomId).toBe(ROOM);
    expect(decision.quietMs).toBe(200 * MINUTE);
  });

  it('不在时段内不开口', () => {
    const decision = evaluateProactive(input({ now: Date.parse('2026-11-16T04:00:00+08:00') }));
    expect(decision).toEqual({ fire: false, reason: '不在允许的时段内' });
  });

  it('到了每日上限不开口', () => {
    expect(evaluateProactive(input({ countToday: 6 }))).toEqual({
      fire: false,
      reason: '今天已经开口 6 次，达到上限',
    });
  });

  it('距上次开口太近不开口', () => {
    const decision = evaluateProactive(input({ lastFiredAt: NOW - 10 * MINUTE }));
    expect(decision.fire).toBe(false);
    if (decision.fire) return;
    expect(decision.reason).toContain('还要等');
  });

  it('没有安静够久的房间时说明白', () => {
    const decision = evaluateProactive(
      input({ candidates: [{ roomId: ROOM, name: 'Coo', lastActivityAt: NOW - 5 * MINUTE, lastFiredAt: 0 }] }),
    );
    expect(decision).toEqual({ fire: false, reason: '没有安静够久的房间可开口' });
  });

  it('概率没命中时不开口', () => {
    const decision = evaluateProactive(input({ chance: 0.2, random: 0.9 }));
    expect(decision.fire).toBe(false);
    if (decision.fire) return;
    expect(decision.reason).toContain('概率未命中');
  });

  it('多个候选时挑最久没说话的，其余作为备选', () => {
    const decision = evaluateProactive(
      input({
        candidates: [
          { roomId: '!a:example.org', name: 'A', lastActivityAt: NOW - 100 * MINUTE, lastFiredAt: 0 },
          { roomId: '!b:example.org', name: 'B', lastActivityAt: NOW - 300 * MINUTE, lastFiredAt: 0 },
        ],
      }),
    );
    expect(decision.fire).toBe(true);
    if (!decision.fire) return;
    expect(decision.target.roomId).toBe('!b:example.org');
    expect(decision.alternatives).toEqual([{ roomId: '!a:example.org', name: 'A' }]);
  });
});

describe('计数', () => {
  it('换日时清零但保留上次开口的时刻', () => {
    const counter = markFired(emptyCounter('2026-11-15'), NOW, ROOM);
    const rolled = rollCounter(counter, '2026-11-16');
    expect(rolled.count).toBe(0);
    expect(rolled.lastFiredAt).toBe(NOW);
  });

  it('同日不重置', () => {
    const counter = markFired(emptyCounter('2026-11-16'), NOW, ROOM);
    expect(rollCounter(counter, '2026-11-16')).toBe(counter);
  });
});
