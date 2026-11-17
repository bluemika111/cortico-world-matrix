/**
 * 环境提示词：模板在这里，占位符的值在 world.ts 里算。
 * 模板正文说明这些事件是什么、什么时候来、附带的是什么。
 */
import { fileURLToPath } from 'node:url';

export const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

export interface EnvVarsInput {
  status: { state: string; detail: string };
  userId: string;
  displayName: string;
  /** 已经渲染好的房间清单。 */
  rooms: string;
  stickers: number;
  voice: boolean;
  proactive: boolean;
  /** 加密策略与启用状态，例如「强制（已启用（设备 X））」。 */
  encryption: string;
}

/** 三段占位符的值：身份、房间清单、此刻可用的能力。 */
export function envPromptVars(input: EnvVarsInput): Record<string, string> {
  const identity = input.userId
    ? `${input.displayName || '未知名'}（${input.userId}），连接状态：${input.status.detail}`
    : `连接状态：${input.status.detail}（账号信息还没拿到）`;

  const capabilities: string[] = [];
  capabilities.push(input.stickers > 0 ? `表情包图库里有 ${input.stickers} 张图` : '表情包图库是空的');
  capabilities.push(input.voice ? '语音收发开着：语音消息会转成文字，也能把回复念成语音' : '语音收发关着');
  capabilities.push(input.proactive ? '会按节奏给你主动开口的机会' : '不会主动给你开口的机会');
  capabilities.push(`端到端加密：${input.encryption}`);

  return {
    'matrix.identity': identity,
    'matrix.rooms': input.rooms,
    'matrix.capabilities': `${capabilities.join('；')}。`,
  };
}
