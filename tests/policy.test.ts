import { describe, expect, it } from 'vitest';
import {
  conversationKey,
  humanGap,
  inClockWindow,
  localDateKey,
  minutesOfDay,
  parseClock,
  parseRoomRoster,
  rosterAllows,
} from '../src/policy.ts';

const ROOM = '!qmJoOujSuYtCORt4ZC:example.org';

describe('监听名单', () => {
  it('空输入表示监听全部', () => {
    expect(parseRoomRoster('')).toBeNull();
    expect(parseRoomRoster('   \n ')).toBeNull();
    expect(rosterAllows(null, ROOM)).toBe(true);
  });

  it('逗号、空格、换行与中文标点都算分隔', () => {
    const roster = parseRoomRoster(`!a:example.org, !b:example.org\n#c:example.org；!d:example.org`);
    expect(roster).toEqual(new Set(['!a:example.org', '!b:example.org', '#c:example.org', '!d:example.org']));
  });

  it('认不出的项不算监听的房间', () => {
    // 写成房间名时按「没有可监听的」处理，比悄悄监听全部安全。
    const roster = parseRoomRoster('茶话会 !a:example.org');
    expect(roster).toEqual(new Set(['!a:example.org']));
    expect(parseRoomRoster('茶话会')).toEqual(new Set());
  });

  it('名单外的房间不放行', () => {
    expect(rosterAllows(new Set([ROOM]), ROOM)).toBe(true);
    expect(rosterAllows(new Set(['!other:example.org']), ROOM)).toBe(false);
  });
});

describe('时段', () => {
  it('读 HH:MM', () => {
    expect(parseClock('09:30')).toBe(570);
    expect(parseClock('9:05')).toBe(545);
    expect(parseClock('24:00')).toBeNull();
    expect(parseClock('9-30')).toBeNull();
  });

  it('跨午夜的时段', () => {
    expect(inClockWindow('22:00', '02:00', 23 * 60)).toBe(true);
    expect(inClockWindow('22:00', '02:00', 1 * 60)).toBe(true);
    expect(inClockWindow('22:00', '02:00', 12 * 60)).toBe(false);
  });

  it('读不出时段时视为全天', () => {
    expect(inClockWindow('', '', 500)).toBe(true);
    expect(inClockWindow('09:00', '09:00', 500)).toBe(true);
  });

  it('按给定时区算分钟数与日期', () => {
    const at = Date.parse('2026-11-16T13:41:28+08:00');
    expect(minutesOfDay('Asia/Shanghai', at)).toBe(13 * 60 + 41);
    expect(localDateKey('Asia/Shanghai', at)).toBe('2026-11-16');
    expect(localDateKey('UTC', at)).toBe('2026-11-16');
  });
});

describe('杂项', () => {
  it('senderKey 一个房间一个稳定键', () => {
    expect(conversationKey(ROOM)).toBe(`matrix.${ROOM}`);
  });

  it('把毫秒写成中文时长', () => {
    expect(humanGap(30_000)).toBe('不到一分钟');
    expect(humanGap(90 * 60_000)).toBe('1 小时 30 分钟');
    expect(humanGap(26 * 3_600_000)).toBe('1 天 2 小时');
  });
});
