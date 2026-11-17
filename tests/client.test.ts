import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { MatrixClient, MatrixError, loginWithPassword, normalizeBase } from '../src/matrix/client.ts';

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

interface Harness {
  client: MatrixClient;
  requests: Recorded[];
  close(): Promise<void>;
}

const TOKEN = 'test-token';
const log = {
  child() {
    return this;
  },
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  emit() {},
} as never;

/** 真起一个 HTTP 服务：路径编码、请求头与状态码都要按真实的重来一遍。 */
async function harness(
  handler: (request: Recorded, res: import('node:http').ServerResponse) => boolean | void,
): Promise<Harness> {
  const requests: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const recorded: Recorded = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      requests.push(recorded);
      if (handler(recorded, res)) return;
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ errcode: 'M_NOT_FOUND', error: 'no route' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const client = new MatrixClient({ homeserver: `http://127.0.0.1:${port}/`, accessToken: TOKEN, log });
  return {
    client,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}

describe('normalizeBase', () => {
  it('去掉末尾斜杠', () => {
    expect(normalizeBase(' https://im.example.org/// ')).toBe('https://im.example.org');
  });
});

describe('MatrixClient', () => {
  let harnesses: Harness[] = [];

  afterEach(async () => {
    for (const item of harnesses) await item.close();
    harnesses = [];
  });

  async function start(
    handler: (request: Recorded, res: import('node:http').ServerResponse) => boolean | void,
  ): Promise<Harness> {
    const made = await harness(handler);
    harnesses.push(made);
    return made;
  }

  it('whoami 带上 Bearer 令牌', async () => {
    const h = await start((request, res) =>
      request.path === '/_matrix/client/v3/account/whoami'
        ? json(res, 200, { user_id: '@coo:example.org', device_id: 'DEV' })
        : undefined,
    );
    const who = await h.client.whoami();
    expect(who.userId).toBe('@coo:example.org');
    expect(h.requests[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('sync 带上 timeout，续传时带上编码后的 since', async () => {
    const h = await start((request, res) =>
      request.path === '/_matrix/client/v3/sync'
        ? json(res, 200, { next_batch: 's2' })
        : undefined,
    );
    await h.client.sync(null, 0);
    await h.client.sync('s1+abc/def', 30_000);
    expect(h.requests[0].query.get('timeout')).toBe('0');
    expect(h.requests[0].query.has('since')).toBe(false);
    expect(h.requests[1].query.get('since')).toBe('s1+abc/def');
    expect(h.requests[1].query.get('timeout')).toBe('30000');
  });

  it('房间号与事件 id 在路径里整段编码', async () => {
    const h = await start((request, res) =>
      request.method === 'PUT' && request.path.includes('/send/')
        ? json(res, 200, { event_id: '$sent' })
        : request.method === 'PUT' && request.path.includes('/redact/')
          ? json(res, 200, { event_id: '$redacted' })
          : undefined,
    );
    await h.client.sendEvent('!qmJoOujSuYtCORt4ZC:example.org', 'm.room.message', { body: 'hi' });
    await h.client.redact('!room:example.org', '$VjSbDGCTj-SVdKMeG', '不要了');

    expect(h.requests[0].path).toBe(
      '/_matrix/client/v3/rooms/%21qmJoOujSuYtCORt4ZC%3Aexample.org/send/m.room.message/' +
        h.requests[0].path.split('/').pop(),
    );
    expect(h.requests[1].path).toContain('/rooms/%21room%3Aexample.org/redact/%24VjSbDGCTj-SVdKMeG/');
  });

  it('发送返回 event_id，并原样带上内容', async () => {
    const h = await start((request, res) =>
      request.method === 'PUT' ? json(res, 200, { event_id: '$abc' }) : undefined,
    );
    const id = await h.client.sendEvent('!room:example.org', 'm.room.message', { msgtype: 'm.text', body: '在吗' });
    expect(id).toBe('$abc');
    expect(h.requests[0].headers['content-type']).toBe('application/json');
    expect(JSON.parse(h.requests[0].body.toString())).toEqual({ msgtype: 'm.text', body: '在吗' });
  });

  it('上传返回 mxc 地址，MIME 走 Content-Type', async () => {
    const h = await start((request, res) =>
      request.method === 'POST' && request.path === '/_matrix/media/v3/upload'
        ? json(res, 200, { content_uri: 'mxc://example.org/abc' })
        : undefined,
    );
    const uri = await h.client.upload(new Uint8Array([1, 2, 3]), 'image/png', 'cat.png');
    expect(uri).toBe('mxc://example.org/abc');
    expect(h.requests[0].headers['content-type']).toBe('image/png');
    expect(h.requests[0].query.get('filename')).toBe('cat.png');
    expect(h.requests[0].body.byteLength).toBe(3);
  });

  it('下载先问 v1 媒体端点，404 时退回 v3', async () => {
    const h = await start((request, res) => {
      if (request.path === '/_matrix/client/v1/media/download/example.org/abc') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ errcode: 'M_NOT_FOUND', error: 'gone' }));
        return true;
      }
      if (request.path === '/_matrix/media/v3/download/example.org/abc') {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(Buffer.from([9, 9]));
        return true;
      }
      return undefined;
    });
    const got = await h.client.download('mxc://example.org/abc');
    expect(got.mime).toBe('image/png');
    expect([...got.bytes]).toEqual([9, 9]);
    expect(h.requests.map((item) => item.path)).toEqual([
      '/_matrix/client/v1/media/download/example.org/abc',
      '/_matrix/media/v3/download/example.org/abc',
    ]);
  });

  it('限流时按 retry_after_ms 等一次再重试', async () => {
    let calls = 0;
    const h = await start((request, res) => {
      if (request.path !== '/_matrix/client/v3/joined_rooms') return undefined;
      calls += 1;
      if (calls === 1) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ errcode: 'M_LIMIT_EXCEEDED', error: 'slow down', retry_after_ms: 1 }));
        return true;
      }
      return json(res, 200, { joined_rooms: ['!a:example.org'] });
    });
    expect(await h.client.joinedRooms()).toEqual(['!a:example.org']);
    expect(calls).toBe(2);
  });

  it('错误码与状态原样留下来', async () => {
    const h = await start((request, res) =>
      request.path === '/_matrix/client/v3/joined_rooms'
        ? json(res, 403, { errcode: 'M_FORBIDDEN', error: 'nope' })
        : undefined,
    );
    const error = await h.client.joinedRooms().catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(MatrixError);
    expect((error as MatrixError).errcode).toBe('M_FORBIDDEN');
    expect((error as MatrixError).status).toBe(403);
  });

  it('令牌失效时标成 unauthorized', async () => {
    const h = await start((request, res) =>
      request.path === '/_matrix/client/v3/joined_rooms'
        ? json(res, 401, { errcode: 'M_UNKNOWN_TOKEN', error: 'bad token' })
        : undefined,
    );
    const error = (await h.client.joinedRooms().catch((thrown: unknown) => thrown)) as MatrixError;
    expect(error.unauthorized).toBe(true);
  });

  it('sync 位置失效时可以认出来', async () => {
    const h = await start((request, res) =>
      request.path === '/_matrix/client/v3/sync' ? json(res, 400, { errcode: 'M_UNKNOWN_POS', error: 'bad since' }) : undefined,
    );
    const error = (await h.client.sync('stale', 0).catch((thrown: unknown) => thrown)) as MatrixError;
    expect(error.stalePosition).toBe(true);
  });

  it('别名解成房间号', async () => {
    const h = await start((request, res) =>
      request.path === '/_matrix/client/v3/directory/room/%23coo%3Aexample.org'
        ? json(res, 200, { room_id: '!room:example.org' })
        : undefined,
    );
    expect(await h.client.resolveRoom('#coo:example.org')).toBe('!room:example.org');
  });

  it('messages 按时间升序返回', async () => {
    const h = await start((request, res) =>
      request.path === '/_matrix/client/v3/rooms/%21room%3Aexample.org/messages'
        ? json(res, 200, { start: '10', end: '8', chunk: [{ event_id: '$2' }, { event_id: '$1' }] })
        : undefined,
    );
    const events = await h.client.messages('!room:example.org', 5);
    expect(events.map((item) => item.event_id)).toEqual(['$1', '$2']);
    expect(h.requests[0].query.get('dir')).toBe('b');
  });

  it('abort 之后长轮询立刻收场', async () => {
    const h = await start((request, res) => {
      // 故意不回应：模拟服务端挂住等事件。
      if (request.path === '/_matrix/client/v3/sync') return true;
      return undefined;
    });
    const pending = h.client.sync(null, 30_000).catch((error: unknown) => error);
    h.client.abort();
    const error = (await pending) as MatrixError;
    expect(error).toBeInstanceOf(MatrixError);
    expect(error.errcode).toBe('M_ABORTED');
  });
});

describe('用密码登录', () => {
  it('把账号密码换成设备与令牌，并带上设备名', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ user_id: '@coo:test', access_token: 'tok', device_id: 'DEV1' }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const result = await loginWithPassword('https://hs.test/', {
      user: 'coo',
      password: 'pw',
      deviceName: 'Coopanion@host',
      fetchImpl,
    });

    expect(result).toEqual({ userId: '@coo:test', accessToken: 'tok', deviceId: 'DEV1' });
    expect(calls[0].url).toBe('https://hs.test/_matrix/client/v3/login');
    expect(calls[0].body.identifier).toEqual({ type: 'm.id.user', user: 'coo' });
    expect(calls[0].body.initial_device_display_name).toBe('Coopanion@host');
  });

  it('密码不对时抛出带 errcode 的错误', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ errcode: 'M_FORBIDDEN', error: 'Invalid password' }), { status: 403 })) as unknown as typeof fetch;
    const error = await loginWithPassword('https://hs.test', { user: 'coo', password: 'bad', fetchImpl }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(MatrixError);
    expect((error as MatrixError).errcode).toBe('M_FORBIDDEN');
    expect((error as MatrixError).status).toBe(403);
  });

  it('返回里缺 device_id 时直接报错，别拿半截结果去连', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ user_id: '@coo:test', access_token: 'tok' }), { status: 200 })) as unknown as typeof fetch;
    await expect(loginWithPassword('https://hs.test', { user: 'coo', password: 'pw', fetchImpl })).rejects.toThrow(
      /device_id/,
    );
  });
});
