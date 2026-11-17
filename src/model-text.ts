/**
 * 交给模型的事件正文。
 *
 * 只写 World 能确认的事实：谁在哪个房间说了什么、几点。
 * 该不该接话、怎么接由模型自己判断，这里不放建议。
 *
 * 行首统一是 `[Matrix-房间名 时间]`：房间名用来分辨是哪个房间，时间用来判断隔了多久。
 * 事件 id 不进正文——它四十多个字符，每行都带会把对话读成一堆乱码；要精确指向某条消息时
 * 用 `mx_history`，那里才印 id。
 */
import { humanGap } from './policy.ts';

/** 所有事件共用的行首。 */
function prefix(roomName: string, time: string): string {
  return roomName ? `[Matrix-${roomName} ${time}] ` : `[Matrix ${time}] `;
}

export interface IncomingTextInput {
  roomName: string;
  /** 本地时间 HH:MM。 */
  time: string;
  senderName: string;
  senderId: string;
  body: string;
  /** 这条是编辑，指向被改写的那条事件。 */
  editOf?: string;
}

/** 一条收到的消息：`[Matrix-Coo 21:32] admin: 在吗`。 */
export function renderIncoming(input: IncomingTextInput): string {
  const who = input.senderName || input.senderId || '有人';
  const edited = input.editOf ? '（编辑过）' : '';
  return `${prefix(input.roomName, input.time)}${who}: ${input.body}${edited}`;
}

export type NoticeKind =
  | 'reaction'
  | 'redaction'
  | 'member_join'
  | 'member_leave'
  | 'member_invite'
  | 'member_ban'
  | 'room_name'
  | 'room_topic'
  | 'room_encryption'
  | 'other';

export interface NoticeTextInput {
  kind: NoticeKind;
  time: string;
  roomName: string;
  /** 触发者显示名与 userId。 */
  actorName?: string;
  actorId?: string;
  /** 目标：被贴表情的消息、入群的人、新房间名。 */
  target?: string;
  /** 补充事实：原话、表情、主题。 */
  detail?: string;
}

/** 通知类事件的一行正文。 */
export function renderNotice(input: NoticeTextInput): string {
  const who = input.actorName || String(input.actorId ?? '有人');
  const where = prefix(input.roomName, input.time);
  switch (input.kind) {
    case 'reaction':
      return `${where}${who} 给一条消息贴了表情${input.detail ? ` ${input.detail}` : ''}`;
    case 'redaction':
      return `${where}${who} 撤回了一条消息${input.detail ? `，原话:${input.detail}` : ''}`;
    case 'member_join':
      return `${where}${input.target ?? who} 加入了房间`;
    case 'member_leave':
      return `${where}${input.target ?? who} 离开了房间`;
    case 'member_invite':
      return `${where}${who} 邀请 ${input.target ?? '某人'} 加入房间`;
    case 'member_ban':
      return `${where}${who} 把 ${input.target ?? '某人'} 移出了房间`;
    case 'room_name':
      return `${where}房间改名了：${input.detail ?? input.target ?? ''}`;
    case 'room_topic':
      return `${where}房间主题改成：${input.detail ?? ''}`;
    case 'room_encryption':
      return `${where}这个房间开了端到端加密。`;
    default:
      return `${where}${who} 触发了一条通知${input.detail ? `:${input.detail}` : ''}`;
  }
}

/** 语音转写的结果或失败原因。 */
export function renderTranscript(input: {
  roomName: string;
  time: string;
  senderName: string;
  ok: boolean;
  text?: string;
  reason?: string;
}): string {
  const head = `${prefix(input.roomName, input.time)}${input.senderName} 的语音：`;
  return input.ok ? `${head}${input.text ?? ''}` : `${head}没能转写，${input.reason ?? '原因未知'}。`;
}

export interface ProactiveTextInput {
  now: string;
  roomName: string;
  roomId: string;
  quietMs: number;
  countToday: number;
  maxPerDay: number;
  /** 其他同样安静够久的房间。 */
  alternatives: Array<{ roomName: string; roomId: string }>;
}

/**
 * 主动说话的开口：把「安静了多久、今天第几次、还能挑谁」写成事实。
 * 说不说、说什么、发不发到别处，都由模型决定。
 */
export function renderProactive(input: ProactiveTextInput): string {
  const lines = [
    `[Matrix-${input.roomName} ${input.now}] 这个房间已经 ${humanGap(input.quietMs)} 没有新消息了。今天这是第 ${input.countToday} 次机会（上限 ${input.maxPerDay}）。`,
    `要不要说话、说什么、说到哪里，你自己决定；不说也可以，这次机会就这样过去。`,
  ];
  if (input.alternatives.length) {
    const others = input.alternatives.map((item) => `「${item.roomName}」`).join('、');
    lines.push(`同样安静够久的还有：${others}。`);
  }
  return lines.join('\n');
}

/** 连接状态变化。 */
export function renderStatus(input: { time: string; state: string; detail: string; userId?: string }): string {
  const account = input.userId ? `，账号 ${input.userId}` : '';
  return `[Matrix ${input.time}] ${input.detail}（${input.state}${account}）`;
}
