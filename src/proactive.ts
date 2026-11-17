/**
 * 主动说话的状态机：判断「此刻该不该递给 Coo 一个开口的机会」，以及递给哪个房间。
 *
 * 这里只做机械判定——安静够久、今天还没到上限、在允许的时段、概率过了。
 * 开口说什么、发不发，都是模型自己的判断；这里不生成任何文案。
 */
import { conversationKey, inClockWindow, minutesOfDay } from './policy.ts';

export interface ProactiveCandidate {
  roomId: string;
  name: string;
  lastActivityAt: number;
  /** 上一次对这个房间主动开口的时刻。 */
  lastFiredAt: number;
}

export interface ProactiveInput {
  now: number;
  timezone: string;
  activeFrom: string;
  activeTo: string;
  quietMinutes: number;
  minIntervalMinutes: number;
  chance: number;
  maxPerDay: number;
  /** 今天已经主动开口几次。 */
  countToday: number;
  candidates: readonly ProactiveCandidate[];
  /** 所有房间里最后一次主动开口的时刻。 */
  lastFiredAt: number;
  /** 0–1 的随机数；由调用方给，方便测试。 */
  random: number;
}

export type ProactiveDecision =
  | { fire: false; reason: string }
  | {
      fire: true;
      target: { roomId: string; name: string };
      /** 这个房间安静了多久。 */
      quietMs: number;
      /** 同一批里还可以考虑的房间，按「最久没说话」排序。 */
      alternatives: Array<{ roomId: string; name: string }>;
    };

/**
 * 判定一次。`reason` 是给面板与日志看的一句中文，说明为什么这次没有开口。
 */
export function evaluateProactive(input: ProactiveInput): ProactiveDecision {
  const minutes = minutesOfDay(input.timezone, input.now);
  if (!inClockWindow(input.activeFrom, input.activeTo, minutes)) {
    return { fire: false, reason: '不在允许的时段内' };
  }
  if (input.maxPerDay <= 0) return { fire: false, reason: '每日上限为 0' };
  if (input.countToday >= input.maxPerDay) return { fire: false, reason: `今天已经开口 ${input.countToday} 次，达到上限` };

  const minGap = Math.max(0, input.minIntervalMinutes) * 60_000;
  if (input.lastFiredAt > 0 && input.now - input.lastFiredAt < minGap) {
    const wait = Math.ceil((minGap - (input.now - input.lastFiredAt)) / 60_000);
    return { fire: false, reason: `距上次主动开口不足 ${input.minIntervalMinutes} 分钟，还要等 ${wait} 分钟` };
  }

  const quietMs = Math.max(0, input.quietMinutes) * 60_000;
  const eligible = input.candidates
    .filter((candidate) => input.now - candidate.lastActivityAt >= quietMs)
    .filter((candidate) => candidate.lastFiredAt === 0 || input.now - candidate.lastFiredAt >= minGap)
    .sort((a, b) => a.lastActivityAt - b.lastActivityAt);

  if (eligible.length === 0) {
    return { fire: false, reason: '没有安静够久的房间可开口' };
  }
  if (input.random > input.chance) {
    return { fire: false, reason: `概率未命中（${input.random.toFixed(2)} > ${input.chance}）` };
  }

  const pick = eligible[0];
  return {
    fire: true,
    target: { roomId: pick.roomId, name: pick.name },
    quietMs: input.now - pick.lastActivityAt,
    alternatives: eligible.slice(1, 4).map((c) => ({ roomId: c.roomId, name: c.name })),
  };
}

/** 主动开口的每日计数，按本地日期分桶。 */
export interface DailyCounter {
  date: string;
  count: number;
  /** 上一次开口的时刻。 */
  lastFiredAt: number;
  /** 每个房间上一次开口的时刻。 */
  byRoom: Record<string, number>;
}

export function emptyCounter(date: string): DailyCounter {
  return { date, count: 0, lastFiredAt: 0, byRoom: {} };
}

/** 日期换了就把计数清零，同时保留「上次开口」用于间隔判定。 */
export function rollCounter(counter: DailyCounter | null, date: string): DailyCounter {
  if (!counter) return emptyCounter(date);
  if (counter.date === date) return counter;
  return { date, count: 0, lastFiredAt: counter.lastFiredAt, byRoom: counter.byRoom };
}

/** 记一次开口。 */
export function markFired(counter: DailyCounter, now: number, roomId: string): DailyCounter {
  return {
    date: counter.date,
    count: counter.count + 1,
    lastFiredAt: now,
    byRoom: { ...counter.byRoom, [conversationKey(roomId)]: now },
  };
}
