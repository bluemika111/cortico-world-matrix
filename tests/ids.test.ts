import { describe, expect, it } from 'vitest';
import { encodeSegment, isRoomAlias, isRoomId, isUserId, localpart, mediaNameOf, parseMxc, serverOf } from '../src/matrix/ids.ts';

describe('encodeSegment', () => {
  it('把房间号里的 ! 与 : 都转掉', () => {
    // 服务端按路径分段匹配：只转掉一个字符就会 404，而且报错信息里看不出是编码问题。
    expect(encodeSegment('!qmJoOujSuYtCORt4ZC:example.org')).toBe('%21qmJoOujSuYtCORt4ZC%3Aexample.org');
  });

  it('把 userId 里的 @ 与 : 都转掉', () => {
    expect(encodeSegment('@coo:example.org')).toBe('%40coo%3Aexample.org');
  });

  it('encodeURIComponent 放过的那几个字符也转掉', () => {
    expect(encodeSegment("!a'b(c)d*e:host")).toBe('%21a%27b%28c%29d%2Ae%3Ahost');
  });

  it('保留路径里本来合法的字符', () => {
    expect(encodeSegment('a-b_c.d~e')).toBe('a-b_c.d~e');
  });
});

describe('标识符判定', () => {
  it('认房间号、别名与 userId', () => {
    expect(isRoomId('!abc:example.org')).toBe(true);
    expect(isRoomId('abc')).toBe(false);
    expect(isRoomAlias('#coo:example.org')).toBe(true);
    expect(isUserId('@coo:example.org')).toBe(true);
    expect(isUserId('coo')).toBe(false);
  });

  it('取出服务器名与本地部分', () => {
    expect(serverOf('!abc:example.org')).toBe('example.org');
    expect(serverOf('abc')).toBe('');
    expect(localpart('@coo:example.org')).toBe('coo');
    expect(localpart('!abc:example.org')).toBe('!abc:example.org');
  });
});

describe('mxc 地址', () => {
  it('拆出服务器与媒体 id', () => {
    expect(parseMxc('mxc://example.org/AbCd')).toEqual({ server: 'example.org', mediaId: 'AbCd' });
  });

  it('不是 mxc 时返回 null', () => {
    expect(parseMxc('https://example.org/x.png')).toBeNull();
    expect(parseMxc('mxc://example.org')).toBeNull();
    expect(parseMxc('mxc:///abc')).toBeNull();
  });

  it('媒体 id 可以当文件名用', () => {
    expect(mediaNameOf('mxc://example.org/AbCd')).toBe('AbCd');
    expect(mediaNameOf('nothing')).toBe('nothing');
  });
});
