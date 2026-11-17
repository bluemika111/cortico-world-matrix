import { describe, expect, it } from 'vitest';
import type { MatrixEvent } from '../src/matrix/client.ts';
import { bodyMentions, mentionsUser, relatesOf, renderEvent } from '../src/matrix/events.ts';

const SELF = '@coo:example.org';
const OTHER = '@admin:example.org';

function event(type: string, content: Record<string, unknown>, sender = OTHER): MatrixEvent {
  return { type, event_id: '$e1', sender, origin_server_ts: 1_700_000_000_000, content };
}

describe('renderEvent', () => {
  it('普通文本原样给出', () => {
    const rendered = renderEvent(event('m.room.message', { msgtype: 'm.text', body: '在吗' }), { selfUserId: SELF });
    expect(rendered?.text).toBe('在吗');
    expect(rendered?.msgtype).toBe('m.text');
  });

  it('动作消息带上星号', () => {
    const rendered = renderEvent(event('m.room.message', { msgtype: 'm.emote', body: '打了个哈欠' }), { selfUserId: SELF });
    expect(rendered?.text).toBe('* 打了个哈欠');
  });

  it('图片、语音与文件留占位并挑出媒体', () => {
    const image = renderEvent(
      event('m.room.message', { msgtype: 'm.image', body: 'cat.png', url: 'mxc://example.org/a', info: { mimetype: 'image/png', size: 12 } }),
      { selfUserId: SELF },
    );
    // 文件名不进正文：图片本身会作为附件给出去，`image.png` 这种名字只是噪声。
    expect(image?.text).toBe('[图片]');
    expect(image?.images).toEqual([{ mxc: 'mxc://example.org/a', name: 'cat.png', mimetype: 'image/png', size: 12, sticker: false }]);

    const audio = renderEvent(
      event('m.room.message', { msgtype: 'm.audio', body: 'voice.ogg', url: 'mxc://example.org/b' }),
      { selfUserId: SELF },
    );
    expect(audio?.text).toBe('[语音]');
    expect(audio?.audio).toHaveLength(1);

    const file = renderEvent(
      event('m.room.message', { msgtype: 'm.file', body: 'a.pdf', url: 'mxc://example.org/c' }),
      { selfUserId: SELF },
    );
    expect(file?.text).toBe('[文件:a.pdf]');
    expect(file?.files).toHaveLength(1);
  });

  it('表情包事件认成表情包', () => {
    const rendered = renderEvent(event('m.sticker', { body: '猫猫', url: 'mxc://example.org/s' }), { selfUserId: SELF });
    expect(rendered?.text).toBe('[表情包:猫猫]');
    expect(rendered?.stickers).toHaveLength(1);
    expect(rendered?.stickers[0].sticker).toBe(true);
  });

  it('加密消息只留占位', () => {
    const rendered = renderEvent(event('m.room.encrypted', {}), { selfUserId: SELF });
    expect(rendered?.text).toBe('[加密消息]');
    expect(rendered?.msgtype).toBe('m.room.encrypted');
  });

  it('撤回过的消息内容已被抹掉，只剩标记', () => {
    const rendered = renderEvent(
      { type: 'm.room.message', event_id: '$gone', sender: OTHER, content: {}, unsigned: { redacted_because: {} } },
      { selfUserId: SELF },
    );
    expect(rendered?.text).toBe('[已撤回]');
  });

  it('不认识的类型返回 null', () => {
    expect(renderEvent(event('m.room.topic', { topic: 'x' }), { selfUserId: SELF })).toBeNull();
  });

  it('编辑事件读新内容并记下被改写的那条', () => {
    const rendered = renderEvent(
      event('m.room.message', {
        msgtype: 'm.text',
        body: '* 改过的',
        'm.new_content': { msgtype: 'm.text', body: '改过的' },
        'm.relates_to': { rel_type: 'm.replace', event_id: '$orig' },
      }),
      { selfUserId: SELF },
    );
    expect(rendered?.text).toBe('改过的');
    expect(rendered?.editOf).toBe('$orig');
  });

  it('回复记下被引用的消息', () => {
    const rendered = renderEvent(
      event('m.room.message', {
        msgtype: 'm.text',
        body: '同意',
        'm.relates_to': { 'm.in_reply_to': { event_id: '$parent' } },
      }),
      { selfUserId: SELF },
    );
    expect(rendered?.replyToId).toBe('$parent');
  });
});

describe('提及', () => {
  it('m.mentions 里的 user_ids', () => {
    expect(mentionsUser({ 'm.mentions': { user_ids: [SELF] } }, SELF)).toBe(true);
    expect(mentionsUser({ 'm.mentions': { user_ids: [OTHER] } }, SELF)).toBe(false);
    expect(mentionsUser({}, SELF)).toBe(false);
  });

  it('正文里写 @ 本地名也算', () => {
    expect(bodyMentions('@coo 在吗', SELF)).toBe(true);
    expect(bodyMentions('@Coo 在吗', SELF)).toBe(true);
    expect(bodyMentions('跟他说话', SELF)).toBe(false);
  });

  it('写了显示名也算', () => {
    expect(bodyMentions('@Coo 出来', SELF, 'Coo')).toBe(true);
  });

  it('消息里的提及会直接反映在渲染结果上', () => {
    const rendered = renderEvent(
      event('m.room.message', { msgtype: 'm.text', body: '叫你', 'm.mentions': { user_ids: [SELF] } }),
      { selfUserId: SELF },
    );
    expect(rendered?.mentionedSelf).toBe(true);
  });
});

describe('relatesOf', () => {
  it('线程与回复可以同时存在', () => {
    expect(
      relatesOf({
        'm.relates_to': { rel_type: 'm.thread', event_id: '$thread', 'm.in_reply_to': { event_id: '$parent' } },
      }),
    ).toEqual({ threadOf: '$thread', replyToId: '$parent' });
  });
});
