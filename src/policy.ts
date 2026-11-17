/**
 * 策略里那些纯计算：监听名单、时段、话题去重。
 * 全部无副作用，状态机与 World 都只借用这里。
 */

/** 一个房间的引用。Matrix 里所有会话都是房间，没有群与私聊之分。 */
export interface ConversationRef {
  roomId: string;
}

/** 事件的 `senderKey`：一个房间一个稳定键，同一房间的消息合批投递。 */
export function conversationKey(roomId: string): string {
  return `matrix.${roomId}`;
}

/**
 * 把输入框里的文本读成监听集合。
 *
 * 只收 `!房间号` 与 `#别名`，其余内容忽略：认不出的项如果放行成「监听全部」，
 * 一次手误就把 Coo 接进了所有房间。返回 null 表示输入框是空的，即监听全部。
 */
export function parseRoomRoster(text: string): Set<string> | null {
  const tokens = text
    .split(/[\s,，;；、]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) return null;
  const ids = new Set<string>();
  for (const token of tokens) {
    if (token.startsWith('!') || token.startsWith('#')) ids.add(token);
  }
  return ids;
}

/** 名单是否放行这个房间；null 是全部放行。 */
export function rosterAllows(roster: Set<string> | null, roomId: string): boolean {
  if (roster === null) return true;
  return roster.has(roomId);
}

/** `HH:MM` 读成一天里的分钟数；读不出时返回 null。 */
export function parseClock(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** 时刻是否落在允许的时段内；`from` 晚于 `to` 表示跨午夜。读不出时视为全天。 */
export function inClockWindow(from: string, to: string, minutes: number): boolean {
  const start = parseClock(from);
  const end = parseClock(to);
  if (start === null || end === null || start === end) return true;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

/** 某个时刻在一份时区里的本地分钟数。 */
export function minutesOfDay(timezone: string, at: number): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(at));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return (hour % 24) * 60 + minute;
}

/** 某个时刻对应的本地日期，用作「今天」的计数桶。 */
export function localDateKey(timezone: string, at: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(at));
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

/** 从毫秒数读出一句「多久」的中文说法。 */
export function humanGap(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return '不到一分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  const extra = hours % 24;
  return extra ? `${days} 天 ${extra} 小时` : `${days} 天`;
}
