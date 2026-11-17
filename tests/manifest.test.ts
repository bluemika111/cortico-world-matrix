import { describe, expect, it } from 'vitest';
import manifest from '../describe.json' with { type: 'json' };
import { MATRIX_DEFAULTS } from '../src/config.ts';
import { MATRIX } from '../src/definition.ts';
import { MATRIX_TOOL_DECLS } from '../src/tools.ts';
import { MatrixWorld } from '../src/world.ts';

/** World 推出的每一种事件。改这里就等于改对外的契约。 */
const EVENT_TYPES = [
  'matrix.message',
  'matrix.reaction',
  'matrix.redaction',
  'matrix.member',
  'matrix.room',
  'matrix.transcript',
  'matrix.proactive',
  'matrix.status',
];

describe('describe.json', () => {
  it('与代码里的工具声明逐条对得上', () => {
    expect(manifest.tools.map((tool: { name: string }) => tool.name)).toEqual(MATRIX_TOOL_DECLS.map((tool) => tool.name));
    expect(manifest.tools).toEqual(MATRIX.describe?.tools as unknown as typeof manifest.tools);
  });

  it('事件类型与代码里的一致', () => {
    expect(manifest.events.map((event: { type: string }) => event.type)).toEqual(EVENT_TYPES);
    expect(MATRIX.describe?.events.map((event) => event.type)).toEqual(EVENT_TYPES);
  });

  it('环境提示词模板也在里面', () => {
    expect(manifest.prompts).toHaveLength(1);
    expect(manifest.prompts[0].role).toBe('envPrompt');
    expect(manifest.prompts[0].content).toContain('{{matrix.identity}}');
  });
});

describe('定义', () => {
  it('以默认配置就能构造，未启用时连都不连', () => {
    expect(MATRIX.id).toBe('matrix');
    const world = MATRIX.create({
      id: 'matrix',
      cfg: { ...structuredClone(MATRIX_DEFAULTS), enabled: false },
      timezone: 'Asia/Shanghai',
      botName: 'Coo',
      botDir: '',
      packageDir: '',
      dataDir: '',
      repoRoot: '',
      secret: () => '',
      storeSecret: () => {},
      persist: () => {},
      restart: async () => {},
    });
    expect(world.id).toBe('matrix');
    expect(world.tools().length).toBeGreaterThan(0);
    expect(world.webUi?.('en').label).toBe('Matrix');
  });

  it('默认配置里该有的段都在', () => {
    expect(MATRIX.defaults()).toEqual(MATRIX_DEFAULTS);
    expect(MATRIX.defaults().sticker.enabled).toBe(true);
    expect(MATRIX.defaults().proactive.enabled).toBe(false);
    expect(MATRIX.defaults().voice.enabled).toBe(false);
    // 每次给一份新的：改了默认值不该影响下一个实例。
    const first = MATRIX.defaults();
    first.sticker.dir = '改过的';
    expect(MATRIX.defaults().sticker.dir).toBe('');
  });

  it('World 类自报的 id 与定义一致', () => {
    const world = new MatrixWorld({
      cfg: structuredClone(MATRIX_DEFAULTS),
      timezone: 'Asia/Shanghai',
      dataDir: '',
      botName: 'Coo',
      secret: () => undefined,
      persist: () => {},
      restart: () => {},
    });
    expect(world.id).toBe(MATRIX.id);
  });
});
