/**
 * Matrix 接入的六个面板：连接与开关、房间、端到端加密、表情包、主动说话、语音。
 *
 * 面板只做两件事：把此刻的状态显示出来，把操作交给 `invoke`。
 * 配置旋钮在配置组里，这里放的是要按钮和输入框才顺手的那些。
 */
import type { WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';

interface ConnectionStatus {
  state: string;
  detail: string;
  userId: string;
  displayName: string;
  homeserver: string;
  tokenSet: boolean;
  loginUser: string;
  loginDeviceName: string;
  syncTimeoutMs: number;
  receiveRooms: boolean;
  onlyMentionInRoom: boolean;
  listenRooms: string;
  roomCount: number;
  lastError: string;
}

interface EncryptionStatus {
  mode: 'strict' | 'on' | 'off';
  modeLabel: string;
  state: 'off' | 'missing' | 'ready' | 'failed';
  label: string;
  error: string;
  device: string;
  rooms: Array<{ roomId: string; name: string; encrypted: boolean; allowed: boolean }>;
}

interface DepsStatus {
  packageDir: string;
  declared: boolean;
  installed: boolean;
  version: string;
  nativeInstalled: boolean;
  loadable: boolean;
  error: string;
  installing: boolean;
  installLog: string;
  installOk: boolean | null;
}

interface RoomRow {
  roomId: string;
  name: string;
  members: number | null;
  alias: string | null;
  encrypted: boolean;
  watched: boolean;
  reachable: boolean;
}

interface StickerList {
  dir: string;
  enabled: boolean;
  packs: Array<{ name: string; count: number }>;
  entries: Array<{ id: string; name: string; pack: string; bytes: number }>;
}

interface ProactiveStatus {
  enabled: boolean;
  maxPerDay: number;
  countToday: number;
  lastFiredAt: number | null;
  reason: string;
  candidates: Array<{ roomId: string; name: string; quietMinutes: number }>;
}

interface VoiceProbe {
  ffmpeg: string | null;
  ffmpegDetail: string;
  asr: string;
  tts: string;
}

const TEXT = {
  zh: {
    connection: {
      title: '连接与开关',
      desc: '服务器地址与访问令牌改完会重启进程；推送开关与监听名单立即生效。',
      status: '状态',
      refresh: '刷新',
      probe: '测试连通性',
      homeserver: '服务器地址',
      token: '访问令牌',
      tokenKeep: '已设置，留空保持不变',
      syncTimeout: '长轮询（毫秒）',
      saveConnection: '保存连接',
      saved: '已保存，正在重启进程。',
      login: '用账号密码登录',
      loginHint:
        '每台机器各自登录一次，服务端每次都会发一个独立设备。不要把同一份令牌抄到两台机器上——那样两边的加密密钥会互相覆盖，加密消息就再也收不到了。',
      loginUser: '账号',
      loginPassword: '密码',
      loginDevice: '设备名',
      loginDevicePlaceholder: 'Coopanion@主机名',
      loginButton: '登录并连接',
      switches: '推送开关',
      receiveRooms: '房间消息推给 Coo',
      onlyMention: '只在被 @ 或被回复时推送',
      saveSwitches: '保存开关',
      roster: '监听名单',
      rosterHint: '房间号（!xxx:server）或别名，逗号/空格/换行分隔。留空表示监听所有已加入的房间。',
      listenRooms: '监听房间',
      saveRoster: '保存名单',
      ok: '已保存。',
      unknown: '—',
    },
    rooms: {
      title: '房间',
      desc: '已加入的房间。被邀请的房间要先在客户端里接受，扩展才看得见。',
      refresh: '刷新',
      name: '房间',
      id: '房间号',
      members: '人数',
      state: '状态',
      encrypted: '已加密',
      plain: '明文',
      watched: '在监听',
      unwatched: '不在名单',
      alias: '别名',
      empty: '还没有加入任何房间。',
      offline: '连接没起来，房间列表可能不是最新的。',
      count: (n: number) => `共 ${n} 个房间`,
    },
    encryption: {
      title: '端到端加密',
      desc: '策略决定哪些房间能跟 Coo 说话；启用状态说明加密层此刻到底起没起来。改策略会重启进程。',
      mode: '策略',
      strict: '强制',
      on: '启用',
      off: '关闭',
      strictHint: '只连加密房间：明文房间的消息不叫醒 Coo，往明文房间发东西直接拒绝。',
      onHint: '加密与明文房间都能用；加密层起不来时退回明文并报出原因。',
      offHint: '不加载加密层，加密房间里的消息只显示占位。',
      state: '启用状态',
      device: '设备',
      reload: '重新加载加密层',
      reloaded: '已请求重启。',
      rooms: '房间',
      encrypted: '已加密',
      plain: '明文',
      allowed: '可用',
      blocked: '策略禁止',
      empty: '还没有加入任何房间。',
      deps: '端到端加密依赖',
      depsHint:
        '加密房间要 matrix-bot-sdk 和它的原生模块。没装也能用，只是加密房间读不到。原生模块从 GitHub 下载，下载时会关掉证书校验（杀毒软件或代理的 TLS 中间人会挡住证书链），只影响那一次下载。点安装后可能弹出一个命令行窗口，那是 pnpm 在下载，不用管它——进度会实时显示在下面。',
      install: '安装加密依赖',
      installing: '正在安装…',
      installed: '已安装',
      missing: '未安装',
      version: '版本',
      native: '原生模块',
      nativeOk: '在',
      nativeMissing: '缺失',
      loadable: '可加载',
      notLoadable: '加载失败',
      dir: '目录',
      restartHint: '装完重启进程生效。',
    },
    stickers: {
      title: '表情包',
      desc: '图库就是表情目录：`<目录>/<分组>/<图片>`。Coo 用 mx_stickers 挑图、mx_send 的 sticker 参数发出去。',
      dir: '目录',
      filter: '按名字或分组筛选',
      rescan: '重新扫描',
      name: '名字',
      pack: '分组',
      size: '大小',
      empty: '图库是空的：把图片放进目录后点「重新扫描」。',
      noMatch: '没有匹配的表情。',
      disabled: '功能关着，去配置组打开「表情包」。',
      count: (n: number) => `共 ${n} 张`,
    },
    proactive: {
      title: '主动说话',
      desc: '状态机只决定「什么时候可以开口」；说不说、说什么由 Coo 决定。上限与节奏在配置组里。',
      fire: '立即发起一次',
      fired: '已把开口机会递过去。',
      state: '状态',
      today: '今天',
      reason: '上次判断',
      candidates: '安静够久的房间',
      none: '还没有可开口的房间。',
      off: '主动说话关着。',
      minutes: (n: number) => `${n} 分钟前`,
    },
    voice: {
      title: '语音',
      desc: '识别与合成的接入参数在配置组里；这里只报告这台机器上真正能用的东西。',
      probe: '检测',
      ffmpeg: 'ffmpeg',
      asr: '识别',
      tts: '合成',
      missing: '没找到',
    },
  },
  en: {
    connection: {
      title: 'Connection and switches',
      desc: 'Changing the homeserver or token restarts the process; the delivery switch and watch list apply at once.',
      status: 'Status',
      refresh: 'Refresh',
      probe: 'Test connectivity',
      homeserver: 'Homeserver',
      token: 'Access token',
      tokenKeep: 'set; leave empty to keep it',
      syncTimeout: 'Sync timeout (ms)',
      saveConnection: 'Save connection',
      saved: 'Saved; the process is restarting.',
      login: 'Log in with a password',
      loginHint:
        'Log in once per machine: the server issues a separate device each time. Never copy one token onto two machines — their encryption keys would overwrite each other and encrypted messages would stop arriving.',
      loginUser: 'Account',
      loginPassword: 'Password',
      loginDevice: 'Device name',
      loginDevicePlaceholder: 'Coopanion@host',
      loginButton: 'Log in and connect',
      switches: 'Delivery',
      receiveRooms: 'Room messages wake Coo',
      onlyMention: 'Only mentions and replies wake Coo',
      saveSwitches: 'Save switches',
      roster: 'Watch list',
      rosterHint: 'Room ids (!opaque:server) or aliases, separated by commas, spaces or newlines. Empty watches every joined room.',
      listenRooms: 'Rooms',
      saveRoster: 'Save list',
      ok: 'Saved.',
      unknown: '—',
    },
    rooms: {
      title: 'Rooms',
      desc: 'Joined rooms. An invite has to be accepted in a client before the extension can see the room.',
      refresh: 'Refresh',
      name: 'Room',
      id: 'Room id',
      members: 'Members',
      state: 'State',
      encrypted: 'encrypted',
      plain: 'plaintext',
      watched: 'watched',
      unwatched: 'not watched',
      alias: 'Alias',
      empty: 'No room has been joined yet.',
      offline: 'The connection is down; this list may be stale.',
      count: (n: number) => `${n} rooms`,
    },
    encryption: {
      title: 'End-to-end encryption',
      desc: 'The policy decides which rooms the model may talk in; the state says whether the crypto layer actually came up. Changing the policy restarts the process.',
      mode: 'Policy',
      strict: 'Strict',
      on: 'On',
      off: 'Off',
      strictHint: 'Encrypted rooms only: plaintext rooms never wake the model, and sending there is refused.',
      onHint: 'Both kinds work; a failed crypto start falls back to plaintext and shows the reason.',
      offHint: 'Never load the crypto layer; encrypted rooms show a placeholder.',
      state: 'State',
      device: 'Device',
      reload: 'Reload the crypto layer',
      reloaded: 'Restart requested.',
      rooms: 'Rooms',
      encrypted: 'encrypted',
      plain: 'plaintext',
      allowed: 'allowed',
      blocked: 'blocked by policy',
      empty: 'No room has been joined yet.',
      deps: 'Encryption dependency',
      depsHint:
        'Encrypted rooms need matrix-bot-sdk and its native module. Without them the world still runs; encrypted rooms just show a placeholder. The native binary comes from GitHub with certificate verification turned off for that one download (antivirus and proxy TLS interception block the chain). Installing may pop up a console window — that is pnpm downloading; ignore it, the progress below updates live.',
      install: 'Install the dependency',
      installing: 'Installing…',
      installed: 'installed',
      missing: 'not installed',
      version: 'Version',
      native: 'Native module',
      nativeOk: 'present',
      nativeMissing: 'missing',
      loadable: 'Loadable',
      notLoadable: 'fails to load',
      dir: 'Directory',
      restartHint: 'Restart the process afterwards.',
    },
    stickers: {
      title: 'Stickers',
      desc: 'The library is a directory: `<dir>/<pack>/<image>`. The model picks with mx_stickers and sends with mx_send sticker.',
      dir: 'Directory',
      filter: 'Filter by name or pack',
      rescan: 'Rescan',
      name: 'Name',
      pack: 'Pack',
      size: 'Size',
      empty: 'The library is empty. Put images in the directory, then rescan.',
      noMatch: 'No matching sticker.',
      disabled: 'Switched off; enable Stickers in the config group.',
      count: (n: number) => `${n} images`,
    },
    proactive: {
      title: 'Proactive chat',
      desc: 'The state machine only decides when an opening is allowed. Whether to speak is the model call. Caps and pacing live in the config group.',
      fire: 'Offer one now',
      fired: 'The opening was handed over.',
      state: 'State',
      today: 'Today',
      reason: 'Last decision',
      candidates: 'Quiet long enough',
      none: 'No room is quiet long enough yet.',
      off: 'Proactive chat is off.',
      minutes: (n: number) => `${n} min ago`,
    },
    voice: {
      title: 'Voice',
      desc: 'ASR and TTS settings live in the config group; this page reports what actually works on this machine.',
      probe: 'Probe',
      ffmpeg: 'ffmpeg',
      asr: 'ASR',
      tts: 'TTS',
      missing: 'not found',
    },
  },
} as const;

function text(language: string) {
  return language === 'en' ? TEXT.en : TEXT.zh;
}

async function guarded<T>(message: HTMLElement, run: () => Promise<T>, onDone: (value: T) => string): Promise<void> {
  message.classList.remove('bad');
  try {
    const value = await run();
    message.textContent = onDone(value);
  } catch (error) {
    message.classList.add('bad');
    message.textContent = String(error);
  }
}

const connectionPanel: WebUiPanel = {
  mount: async (ctx: WebUiPanelContext) => {
    const S = text(ctx.language).connection;
    const { ui, root } = ctx;
    const sheet = ui.sheet({ title: S.title, desc: S.desc });
    const status = ui.msgline(S.status);
    const refresh = ui.button(S.refresh);
    const probe = ui.button(S.probe);
    const bar = ui.rowbar();
    bar.append(refresh, probe, status);
    const probeLog = ui.log({ maxHeight: '170px', empty: '' });
    probeLog.el.style.display = 'none';

    const homeserver = ui.input({ placeholder: 'https://im.example.org' });
    const token = ui.input({ type: 'password', placeholder: 'access token' });
    const syncTimeout = ui.input({ type: 'number', placeholder: '30000' });
    const saveConnection = ui.button(S.saveConnection, { variant: 'primary' });
    const serverRow = ui.rowbar();
    serverRow.append(ui.field(S.homeserver, homeserver));
    const tokenRow = ui.rowbar();
    tokenRow.append(ui.field(S.token, token), ui.field(S.syncTimeout, syncTimeout), saveConnection);

    const loginUser = ui.input({ placeholder: '@you:example.org' });
    const loginPassword = ui.input({ type: 'password', placeholder: '••••••••' });
    const loginDevice = ui.input({ placeholder: S.loginDevicePlaceholder });
    const loginButton = ui.button(S.loginButton, { variant: 'primary' });
    const loginRow = ui.rowbar();
    loginRow.append(
      ui.field(S.loginUser, loginUser),
      ui.field(S.loginPassword, loginPassword),
      ui.field(S.loginDevice, loginDevice),
      loginButton,
    );
    const loginSection = ui.section(S.login, S.loginHint);
    loginSection.append(loginRow);

    const receiveRooms = ui.checkbox(S.receiveRooms, { checked: true });
    const onlyMention = ui.checkbox(S.onlyMention, { checked: false });
    const saveSwitches = ui.button(S.saveSwitches, { variant: 'primary' });
    const switchRow = ui.rowbar();
    switchRow.append(saveSwitches);

    const listenRooms = ui.textarea({ rows: 3, placeholder: S.rosterHint });
    const saveRoster = ui.button(S.saveRoster, { variant: 'primary' });
    const rosterRow = ui.rowbar();
    rosterRow.append(saveRoster);

    const switchesSection = ui.section(S.switches);
    switchesSection.append(receiveRooms.el, onlyMention.el, switchRow);
    const rosterSection = ui.section(S.roster, S.rosterHint);
    rosterSection.append(ui.field(S.listenRooms, listenRooms), rosterRow);

    sheet.body.append(bar, probeLog.el, serverRow, tokenRow, loginSection, switchesSection, rosterSection);
    root.append(sheet.el);

    const load = async () => {
      await guarded(status, () => ctx.invoke<ConnectionStatus>('status', []), (state) => {
        homeserver.value = state.homeserver;
        syncTimeout.value = String(state.syncTimeoutMs);
        token.value = '';
        token.placeholder = state.tokenSet ? S.tokenKeep : 'access token';
        loginUser.value = state.loginUser ?? '';
        loginDevice.value = state.loginDeviceName ?? '';
        receiveRooms.setChecked(state.receiveRooms);
        onlyMention.setChecked(state.onlyMentionInRoom);
        listenRooms.value = state.listenRooms;
        const account = state.userId ? `${state.displayName || '未知名'}(${state.userId})` : S.unknown;
        return `${state.state} · ${state.detail} · ${account}${state.lastError ? ` · ${state.lastError}` : ''}`;
      });
    };

    refresh.addEventListener('click', () => void load(), { signal: ctx.signal });
    loginButton.addEventListener(
      'click',
      () =>
        void guarded(
          status,
          () =>
            ctx.invoke<{ ok: boolean; note: string }>('login', [
              {
                homeserver: homeserver.value,
                user: loginUser.value,
                password: loginPassword.value,
                deviceName: loginDevice.value,
              },
            ]),
          (result) => {
            if (!result.ok) throw new Error(result.note);
            loginPassword.value = '';
            return result.note;
          },
        ),
      { signal: ctx.signal },
    );
    probe.addEventListener(
      'click',
      () =>
        void (async () => {
          probeLog.clear();
          probeLog.el.style.display = '';
          try {
            const result = await ctx.invoke<{ ok: boolean; target: string; detail: string; hints: string[] }>('probe', []);
            probeLog.append(result.target, result.ok ? 'plain' : 'bad');
            probeLog.append(result.detail, result.ok ? 'plain' : 'bad');
            for (const hint of result.hints) probeLog.append(`· ${hint}`);
          } catch (error) {
            probeLog.append(String(error), 'bad');
          }
        })(),
      { signal: ctx.signal },
    );
    saveConnection.addEventListener(
      'click',
      () =>
        void guarded(
          status,
          () =>
            ctx.invoke<string>('save', [
              {
                homeserver: homeserver.value,
                accessToken: token.value,
                syncTimeoutMs: Number(syncTimeout.value) || 0,
              },
            ]),
          () => S.saved,
        ),
      { signal: ctx.signal },
    );
    saveSwitches.addEventListener(
      'click',
      () =>
        void guarded(
          status,
          () =>
            ctx.invoke('switches', [
              { receiveRooms: receiveRooms.input.checked, onlyMentionInRoom: onlyMention.input.checked },
            ]),
          () => S.ok,
        ),
      { signal: ctx.signal },
    );
    saveRoster.addEventListener(
      'click',
      () =>
        void guarded(
          status,
          () => ctx.invoke<{ ok: boolean; note: string }>('roster', [{ listenRooms: listenRooms.value }]),
          (result) => result.note,
        ),
      { signal: ctx.signal },
    );

    await load();
  },
};

const roomsPanel: WebUiPanel = {
  mount: async (ctx: WebUiPanelContext) => {
    const S = text(ctx.language).rooms;
    const { ui, root } = ctx;
    const sheet = ui.sheet({ title: S.title, desc: S.desc });
    const message = ui.msgline('…');
    const refresh = ui.button(S.refresh, { variant: 'primary' });
    const bar = ui.rowbar();
    bar.append(refresh, message);
    const table = ui.table({ head: [S.name, S.id, S.members, S.state], maxHeight: 'calc(100vh - 320px)' });
    sheet.body.append(bar, table.el);
    root.append(sheet.el);

    const load = async () => {
      const result = await ctx.invoke<{ rooms: RoomRow[] }>('list', []);
      table.clear(result.rooms.length === 0 ? S.empty : undefined);
      for (const room of result.rooms) {
        const state: string[] = [room.encrypted ? S.encrypted : S.plain, room.watched ? S.watched : S.unwatched];
        table.addRow([
          { text: room.alias ? `${room.name}\n${room.alias}` : room.name, cls: 'txt' },
          { text: room.roomId, cls: 'mono' },
          room.members === null ? '—' : String(room.members),
          state.join(' · '),
        ]);
      }
      const offline = result.rooms.some((room) => !room.reachable);
      message.classList.toggle('bad', offline);
      message.textContent = result.rooms.length === 0 ? S.empty : S.count(result.rooms.length);
      if (offline) message.textContent = `${message.textContent} · ${S.offline}`;
    };

    refresh.addEventListener('click', () => void load(), { signal: ctx.signal });
    // 连接是异步起来的：面板开着时每 5 秒自己刷一次，不用人点。
    ctx.interval(() => void load(), 5000);
    await load();
  },
};

const encryptionPanel: WebUiPanel = {
  mount: async (ctx: WebUiPanelContext) => {
    const S = text(ctx.language).encryption;
    const { ui, root } = ctx;
    const sheet = ui.sheet({ title: S.title, desc: S.desc });
    const message = ui.msgline('…');
    const reload = ui.button(S.reload);
    const bar = ui.rowbar();
    bar.append(reload, message);

    const mode = ui.segmented(
      [
        { value: 'strict', label: S.strict },
        { value: 'on', label: S.on },
        { value: 'off', label: S.off },
      ],
      {
        value: 'on',
        size: 'sm',
        onSelect: (value) => {
          void guarded(
            message,
            () => ctx.invoke<{ ok: boolean; note: string }>('mode', [{ mode: value }]),
            (result) => result.note,
          );
        },
      },
    );
    const hint = ui.msgline('');
    const stateEl = ui.kv([]);
    const table = ui.table({ head: [S.rooms, '', ''], maxHeight: 'calc(100vh - 380px)' });

    // 依赖体检与安装：装不上加密依赖的人多半卡在原生模块，这里把两步一起做掉。
    const depsSection = ui.section(S.deps, S.depsHint);
    let depsState = ui.kv([]);
    const install = ui.button(S.install, { variant: 'primary' });
    const depsMessage = ui.msgline('');
    const depsBar = ui.rowbar();
    depsBar.append(install, depsMessage);
    const depsLog = ui.log({ maxHeight: '240px', empty: '' });
    depsSection.append(depsState, depsBar, depsLog.el);

    sheet.body.append(bar, ui.field(S.mode, mode.el), hint, stateEl, table.el, depsSection);
    root.append(sheet.el);

    const hints: Record<string, string> = { strict: S.strictHint, on: S.onHint, off: S.offHint };

    const loadDeps = async () => {
      const deps = await ctx.invoke<DepsStatus>('deps', []);
      const next = ui.kv([
        { k: S.state, v: deps.loadable ? S.installed : deps.installed ? S.notLoadable : S.missing },
        { k: S.version, v: deps.version || '—' },
        { k: S.native, v: deps.nativeInstalled ? S.nativeOk : S.nativeMissing },
        { k: S.dir, v: deps.packageDir },
      ]);
      depsState.replaceWith(next);
      depsState = next;
      install.disabled = deps.installing;
      depsMessage.classList.toggle('bad', !deps.loadable && !deps.installing);
      depsMessage.textContent = deps.installing
        ? S.installing
        : deps.loadable
          ? ''
          : deps.error || S.missing;
      if (deps.installLog) {
        depsLog.clear();
        for (const line of deps.installLog.split('\n')) depsLog.append(line);
        if (deps.installOk === true) depsLog.append(S.restartHint, 'plain');
      }
      return deps;
    };

    const load = async () => {
      const status = await ctx.invoke<EncryptionStatus>('status', []);
      mode.setValue(status.mode);
      hint.textContent = hints[status.mode] ?? '';
      const next = ui.kv([
        { k: S.state, v: status.label },
        { k: S.device, v: status.device || '—' },
      ]);
      stateEl.replaceWith(next);
      message.textContent = status.state === 'ready' ? '' : status.error || status.label;
      message.classList.toggle('bad', status.state !== 'ready');
      table.clear(status.rooms.length === 0 ? S.empty : undefined);
      for (const room of status.rooms) {
        table.addRow([
          room.name,
          { text: room.roomId, cls: 'mono' },
          `${room.encrypted ? S.encrypted : S.plain} · ${room.allowed ? S.allowed : S.blocked}`,
        ]);
      }
    };

    install.addEventListener(
      'click',
      () =>
        void (async () => {
          await guarded(depsMessage, () => ctx.invoke<{ ok: boolean; note: string }>('install', []), (result) => result.note);
          // 先把「正在安装」和第一批输出取回来，再按 1 秒一次跟进。
          await loadDeps();
          // 安装是后台跑的：每 1 秒看一次进度，装完就停。
          const timer = ctx.interval(() => {
            void loadDeps().then((deps) => {
              if (!deps.installing) timer.dispose();
            });
          }, 1000);
        })(),
      { signal: ctx.signal },
    );

    reload.addEventListener(
      'click',
      () => void guarded(message, () => ctx.invoke<{ ok: boolean; note: string }>('reload', []), () => S.reloaded),
      { signal: ctx.signal },
    );
    await load();
    await loadDeps();
  },
};

const stickersPanel: WebUiPanel = {
  mount: async (ctx: WebUiPanelContext) => {
    const S = text(ctx.language).stickers;
    const { ui, root } = ctx;
    const sheet = ui.sheet({ title: S.title, desc: S.desc });
    const message = ui.msgline(S.empty);
    const rescan = ui.button(S.rescan, { variant: 'primary' });
    const filter = ui.input({ placeholder: S.filter });
    const bar = ui.rowbar();
    bar.append(rescan, filter, message);
    const table = ui.table({ head: [S.name, S.pack, S.size], maxHeight: 'calc(100vh - 320px)' });
    sheet.body.append(bar, table.el);
    root.append(sheet.el);

    let data: StickerList | null = null;

    const render = () => {
      if (!data) return;
      const needle = filter.value.trim().toLowerCase();
      const visible = data.entries.filter(
        (entry) => !needle || entry.name.toLowerCase().includes(needle) || entry.pack.toLowerCase().includes(needle),
      );
      table.clear(visible.length === 0 ? (data.entries.length === 0 ? S.empty : S.noMatch) : undefined);
      for (const entry of visible) {
        table.addRow([entry.name, entry.pack, `${Math.round(entry.bytes / 1024)} KB`]);
      }
      message.textContent = data.enabled ? `${S.count(data.entries.length)} · ${S.dir}: ${data.dir}` : S.disabled;
      message.classList.toggle('bad', !data.enabled);
    };

    const load = async () => {
      data = await ctx.invoke<StickerList>('list', []);
      render();
    };

    rescan.addEventListener(
      'click',
      () =>
        void (async () => {
          message.textContent = '…';
          try {
            await ctx.invoke('rescan', []);
            await load();
          } catch (error) {
            message.classList.add('bad');
            message.textContent = String(error);
          }
        })(),
      { signal: ctx.signal },
    );
    filter.addEventListener('input', render, { signal: ctx.signal });

    await load();
  },
};

const proactivePanel: WebUiPanel = {
  mount: async (ctx: WebUiPanelContext) => {
    const S = text(ctx.language).proactive;
    const { ui, root } = ctx;
    const sheet = ui.sheet({ title: S.title, desc: S.desc });
    const message = ui.msgline('…');
    const fire = ui.button(S.fire, { variant: 'primary' });
    const bar = ui.rowbar();
    bar.append(fire, message);
    const table = ui.table({ head: [S.candidates, '', ''], maxHeight: 'calc(100vh - 320px)' });
    let stateEl = ui.kv([]);
    sheet.body.append(bar, stateEl, table.el);
    root.append(sheet.el);

    const renderState = (status: ProactiveStatus) => {
      const next = ui.kv([
        { k: S.state, v: status.enabled ? S.today : S.off },
        { k: S.today, v: `${status.countToday} / ${status.maxPerDay}` },
        { k: S.reason, v: status.reason },
      ]);
      stateEl.replaceWith(next);
      stateEl = next;
    };

    const load = async () => {
      const status = await ctx.invoke<ProactiveStatus>('status', []);
      renderState(status);
      message.textContent = status.enabled ? status.reason : S.off;
      message.classList.toggle('bad', !status.enabled);
      table.clear(status.candidates.length === 0 ? S.none : undefined);
      for (const candidate of status.candidates) {
        table.addRow([candidate.name, candidate.roomId, S.minutes(candidate.quietMinutes)]);
      }
    };

    fire.addEventListener(
      'click',
      () =>
        void guarded(
          message,
          () => ctx.invoke<{ ok: boolean; note: string }>('fire', []),
          (result) => (result.ok ? S.fired : result.note),
        ).then(load),
      { signal: ctx.signal },
    );

    await load();
  },
};

const voicePanel: WebUiPanel = {
  mount: async (ctx: WebUiPanelContext) => {
    const S = text(ctx.language).voice;
    const { ui, root } = ctx;
    const sheet = ui.sheet({ title: S.title, desc: S.desc });
    const message = ui.msgline('…');
    const probe = ui.button(S.probe, { variant: 'primary' });
    const bar = ui.rowbar();
    bar.append(probe, message);
    const table = ui.table({ head: ['', ''], maxHeight: '220px' });
    sheet.body.append(bar, table.el);
    root.append(sheet.el);

    const load = async () => {
      const result = await ctx.invoke<VoiceProbe>('probe', []);
      table.clear();
      table.addRow([S.ffmpeg, result.ffmpeg ?? `${S.missing}: ${result.ffmpegDetail}`]);
      table.addRow([S.asr, result.asr]);
      table.addRow([S.tts, result.tts]);
      message.textContent = '';
    };

    probe.addEventListener('click', () => void load(), { signal: ctx.signal });
    await load();
  },
};

export default {
  panels: {
    connection: connectionPanel,
    rooms: roomsPanel,
    encryption: encryptionPanel,
    stickers: stickersPanel,
    proactive: proactivePanel,
    voice: voicePanel,
  },
};
