# cortico-world-matrix

Cortico World 扩展：把 Coo 接到 Matrix。用客户端-服务器 API 的 `sync` 长轮询收消息，没有 WebSocket。端到端加密是可选的：装上 `matrix-bot-sdk` 就能收发加密房间，不装就按明文跑。

World id 是 `matrix`，配置段是 `worlds.matrix`，WebUI 页是 `world:matrix`。工具与事件用 `mx_` / `matrix.` 前缀。

## 能力

| 要求 | 实现 | 开关 |
|---|---|---|
| 房间消息 | `m.room.message`、`m.sticker`，被 @ 或被回复时立即投递 | `receiveRooms` |
| 只监听某几个房间 | `listenRooms` 输入框（房间号或别名），留空监听全部已加入的房间 | — |
| 图片与表情包 | 图片下载成模型附件；表情包进本地图库，可再发出去 | `imageToModel` / `sticker.enabled` |
| 表情回应、撤回、成员进出、房间设置 | 各成事件 | `receiveRooms` |
| 主动说话 | 状态机按安静时长、时段、概率、每日上限递出开口机会 | `proactive.enabled` |
| 语音收发 | 收：下载 `m.audio` → ffmpeg 转 wav → ASR；发：TTS → 上传 → `m.audio` | `voice.enabled` |
| 历史与搜索 | 本地 jsonl 记录，`mx_history` / `mx_search` | — |
| 端到端加密 | 装了 `matrix-bot-sdk` 就解密收到的、加密发出的，加密附件也认 | `encryption` |

「开关打开时才推给 Coo」是硬边界：关掉之后消息照样进记录（`mx_history` 还查得到），但不产生唤醒事件。同一个开关也管发送——关着时往房间里发消息、贴表情都会被拦下，回执写明原因。

`here` 指「最近一次叫醒 Coo 的房间」，不是「最后有人说话的地方」。别的房间有人聊天但那边推送关着时，`here` 不会被带走。

### 与 QQ 插件不一样的地方

Matrix 没有对应物，这几项没有实现：

| QQ 侧 | Matrix 侧 |
|---|---|
| QQ 空间（说说、点赞、评论） | 没有对应功能 |
| QQ 内置表情（`qq_face`） | 表情回应用 `mx_react`，发的是 emoji |
| 戳一戳（`qq_poke`） | 没有对应功能 |
| 账号收藏表情（`qq_custom_faces`） | 没有对应功能；本地图库照样能用 |
| 群与私聊两类会话 | 只有房间；成员数 2 的房间就是私聊 |

## 安装

包没有运行时依赖：HTTP 用 Node 自带的 `fetch`，不需要 `node_modules`。

1. 在 Coopanion 的设置窗口打开「扩展」页，选从本机目录安装，指向 `cortico-world-matrix`。
2. 重启进程。扩展目录下的 `pnpm add <目录>` 会建立 link，之后改源码重启即生效。
3. WebUI 的 World 页出现「Matrix 接入」，点启用。

命令行等价做法：在 Coopanion 的扩展目录里 `corepack pnpm add cortico-world-matrix`。

### 要进加密房间，再装一个依赖

面板「端到端加密」底部有「端到端加密依赖」：显示包是否安装、版本、原生模块在不在、能不能加载，旁边一个「安装加密依赖」按钮——它后台跑 `pnpm add matrix-bot-sdk`，再补原生模块的 `download-lib.js`，输出实时显示在面板上，装完重启进程生效。

命令行等价做法：

```powershell
cd <扩展目录>
corepack pnpm add matrix-bot-sdk
node node_modules\@matrix-org\matrix-sdk-crypto-nodejs\download-lib.js
```

第二条不能省：pnpm 10+ 默认拦掉依赖的构建脚本，原生 crypto 模块不会自动下载。它从 GitHub 拉 14.5 MB 的二进制，脚本里带 `NODE_TLS_REJECT_UNAUTHORIZED=0`——杀毒软件和代理的 TLS 中间人会让证书链验不过（`UNABLE_TO_VERIFY_LEAF_SIGNATURE`），关掉校验才下得下来，这个变量只对那一次下载生效。

如果两条都跑不通（网络完全出不去），也可以把 `matrix-sdk-crypto.win32-x64-msvc.node` 从别的机器拷进 `node_modules\@matrix-org\matrix-sdk-crypto-nodejs\`，文件名不能改。

## 连到自己的服务器

第一次用，在面板「连接与开关」里填服务器地址、账号、密码，点「登录并连接」。插件会打一次 `POST /_matrix/client/v3/login`，把换来的长期令牌写回 `accessToken`，然后重启进程。面板里也可以直接手填令牌，效果一样。

**每台机器各自登录一次。** 每次登录服务端都会发一个**独立设备**（device id），设备名默认是 `Coopanion@主机名`，在客户端的设备列表里能一眼认出是哪台。反过来，把同一份令牌抄到两台机器上，它们就是同一个设备的两份加密库：device keys 互相覆盖，一方的 one-time key 会变成废签名，另一方从此再也解不开加密消息——而且客户端只会安静地显示 `[加密消息]`，不会报「设备密钥已改变」。这个坑真的踩过，排查了很久。

令牌是长期访问令牌。它被吊销（比如在管理面板里删了设备）时 sync 会收到 `M_UNKNOWN_TOKEN`，扩展停在错误状态并在状态行写明，不会反复重试；这时回面板重新登录一次即可。

用密码登录会自动把**旧加密库**挪到 `<账号>.old-<时间戳>`：换了设备之后旧库本来也用不了。要留要删都随你。

### 收消息：sync 长轮询

`GET /_matrix/client/v3/sync?timeout=90000&since=<next_batch>`，一次请求挂在服务端，有事件就立刻回，没事件就挂满 90 秒再回，然后立刻再来一次。

这不是「每 90 秒问一次」：请求是开着的，服务端一有事件就把响应推回来。实测（局域网，tuwunel 2.0）：

| 场景 | 耗时 |
|---|---|
| 消息进服务器 → sync 返回 | 13–19 ms |
| 空闲时一次请求挂多久 | 90 秒（服务端上限） |
| 空闲时的请求频率 | 每 90 秒 1 个 |

- `next_batch` 写进 `<部署数据目录>/matrix/sync.json`，重启后从上次的位置续接，不重放也不丢。
- 第一次启动（或记录被清空）走一次 `timeout=0` 的全量 sync：只取 `next_batch` 与房间状态，**不**把时间线里的旧消息当成新消息投递；随后按 `backfillLimit` 从 `/messages` 回填每个监听房间最近的若干条进记录，回填不叫醒 Coo。
- 服务端最多挂 90 秒。填更大的值它不报错，而是**立刻回一帧空响应**——长轮询会退化成满速轮询。扩展把配置夹在 90 秒以内，另外对「500ms 内返回且没有事件」的响应补 1 秒间隔兜底。
- 反代的读超时要比 `syncTimeoutMs` 大。本站的 nginx 设的是 300s。

### 为什么不用 WebSocket

Matrix 的客户端-服务器 API 里没有 WebSocket 通道，协议只定义了 sync 长轮询；Element 自己也是这么收消息的。上面那张表说明长轮询在延迟上已经等价于推送，差别只在空闲时每 90 秒一个 HTTP 请求。

真正的「服务端主动 POST 过来」只有 Application Service 一条路：homeserver 把事件 POST 到扩展自己开的 HTTP 端点。tuwunel 支持它（`tuwunel.toml` 里内联声明，或在 admin room 发 `!admin appservices register`，不用重启）。代价是：

- bot 得变成 appservice 用户（`sender_localpart`），和现有的 `@coo` 普通账号冲突；
- 本机要开一个 HTTP 端口给容器 POST，认证换成 `as_token` / `hs_token`；
- 插件里整个 sync 循环、`next_batch` 落盘、回填都要换成 webhook 处理。

换来的是零轮询、to-device 事件、虚拟用户与事件拦截——单 bot 聊天用不上。所以这里没做。

### 房间号必须编码

房间号是 `!opaque:server`，userId 是 `@local:server`。放进 URL 路径时要整段编码：`!` → `%21`，`:` → `%3A`。

`encodeURIComponent` 不转 `!`，所以 `src/matrix/ids.ts` 自己补了一道。漏掉编码时服务端按路径分段匹配，多数时候回 404，而错误信息里只会写「找不到」，看不出是编码问题。

### 端到端加密

`encryption` 有三档策略：

| 策略 | 收 | 发 |
|---|---|---|
| **强制** `strict` | 只投递加密房间的消息；明文房间的消息进记录但不叫醒 Coo，明文房间的邀请也不报 | 往明文房间发东西直接拒绝：「由于安全策略，禁止连接非加密房间」 |
| **启用** `on`（默认） | 加密与明文房间都投递 | 两种房间都能发；加密层起不来时退回明文并报出原因 |
| **关闭** `off` | 加密房间只显示 `[加密消息]` | 加密房间拦下并说明；明文房间照常 |

装了 `matrix-bot-sdk` 时，加密房间的收发是这样：

| 方向 | 表现 |
|---|---|
| 收 | `m.room.encrypted` 交给加密机解密，解出来的正文照常进上下文；解不开时留 `[加密消息]` |
| 发 | 内容先加密再以 `m.room.encrypted` 发出；加密附件（图片、语音）先加密字节再上传 |
| 贴表情 | 同样加密 |
| 密钥 | 设备密钥与 megolm 会话存在 `<部署数据目录>/matrix/crypto`，重启后接着用，不会重新建设备 |

面板「端到端加密」显示三件事：当前策略、启用状态（**已启用**（带设备 id）/ **启用失败**（带原因）/ **未启用**）、以及每个房间在当前策略下能不能用。状态行与「加密」灯同步显示同一句话。

加密机接在自己的 sync 循环上，不用 SDK 的循环：每次 sync 把 to-device 消息、一次性密钥计数、设备列表变化喂给它（`updateSyncData`），房间事件也喂一份（`onRoomEvent`，跟踪会话轮换）。所以 `next_batch` 落盘、回填、长轮询这些行为在两种模式下完全一样。

**刚加入加密房间时，旧消息可能解不开。** megolm 会话由发送方的客户端分发给房间里的设备；Coo 是新设备，要等对方客户端在线、收到密钥请求后才会把会话发过来。在那之前那些消息显示 `[加密消息]`，之后新来的消息正常。这是 Matrix 的机制，不是扩展的问题。

真机验证：

```powershell
corepack pnpm probe:crypto   # 加密层能不能起来、设备密钥传不传得上去
corepack pnpm probe:e2ee     # 加密收发：自己发一条再读回来，验完撤回
```

## 事件正文长什么样

每一行都以 `[Matrix-房间名 时间]` 开头，后面是说话人和内容：

```
[Matrix-Coo 18:35] admin 🏳️‍⚧️: 在吗
[Matrix-Coo 18:36] admin 🏳️‍⚧️: [图片]
[Matrix-Coo 18:37] admin 🏳️‍⚧️ 给一条消息贴了表情 👍
[Matrix-Coo 18:38] admin 🏳️‍⚧️ 的语音：今天好累啊
```

事件 id 不进正文——它四十多个字符，每行都带会把对话读成一堆乱码。要精确指向某条消息时用 `mx_history`，那里每行开头印完整 id。

## 工具

| 工具 | 做什么 |
|---|---|
| `mx_send` | 往房间发文本、图片、表情包或语音；可引用（`reply_to: last` 引用刚叫醒你的那条）、可提及（显示名、`@本地名` 或完整 userId） |
| `mx_stickers` | 列出或搜索本地表情包图库；模型能看图时前几张带图 |
| `mx_voice` | 把一句话合成语音发出去 |
| `mx_react` | 给某条消息贴一个 emoji；不给 id 就贴刚叫醒你的那条 |
| `mx_redact` | 撤回自己发的一条消息；不给 id 就撤这个房间里自己最后发的那条 |
| `mx_history` | 读某个房间的近期记录，或某条消息前后的一段；每行带事件 id |
| `mx_search` | 按关键词搜已记录的会话消息 |
| `mx_rooms` | 列出已加入的房间、成员（带 userId）、加密状态与是否在监听 |
| `mx_status` | 报连接状态、账号与监听名单 |

发消息、贴表情、撤回都会改变外部状态，房间里的人看得见。工具回执里带事件 id，要指向更早的消息时从 `mx_history` 里取。

## 事件

| 类型 | 什么时候来 |
|---|---|
| `matrix.message` | 监听的房间里来了消息 |
| `matrix.reaction` | 有人给消息贴了表情 |
| `matrix.redaction` | 有人撤回了消息 |
| `matrix.member` | 有人加入、离开、被邀请或被移出房间 |
| `matrix.room` | 房间改名、改主题，或打开了端到端加密 |
| `matrix.transcript` | 一条语音的转写结果，或没能转写的原因 |
| `matrix.proactive` | 某个房间安静够久了，给 Coo 一次开口的机会 |
| `matrix.status` | 与服务器的同步建立或断开 |

## 面板

| 页 | 内容 |
|---|---|
| 连接与开关 | 状态、连通性自检、服务器与令牌、长轮询时长；推送开关与监听名单 |
| 房间 | 已加入的房间、成员数、加密与监听状态，以及要监听哪几个 |
| 端到端加密 | 策略（强制 / 启用 / 关闭）、启用状态与失败原因、每个房间能不能用、重新加载加密层；依赖体检与「安装加密依赖」按钮 |
| 表情包 | 图库列表与重新扫描 |
| 主动说话 | 状态机此刻的判断、今天的计数、手动发起一次 |
| 语音 | ffmpeg、识别与合成服务的探测结果 |

## 排错

先点「连接与开关」里的「测试连通性」，它按顺序报三件事：服务器版本端点在不在、令牌属于谁、加入了几个房间。

| 现象 | 原因 |
|---|---|
| 状态行「访问令牌是空的」 | 配置里的 `accessToken` 没填 |
| 状态行 `M_UNKNOWN_TOKEN` | 令牌被吊销或换了账号；重新登录一次，把新令牌填进来 |
| 状态行「同步失败 … 404」 | 房间号没编码，或反代没放行 `/_matrix/` 下的路径 |
| 房间列表是空的 | 账号还没接受邀请；先在客户端里接受，扩展才看得见 |
| 图片显示「没能附上」 | 媒体下载失败：服务端按 `media_retention` 清掉旧媒体后就是 404，本站保留 30 天 |
| 面板一直是「正在连接」 | 反代读超时比长轮询时长短，请求被提前掐断；把读超时调到 300s |
| 加密房间的消息一直是 `[加密消息]` | 见下面「加密消息一直解不开」 |
| 发送失败，报 `no forward extremities` | 见下面「发送报 no forward extremities」 |

### 发送报 `no forward extremities`

这个错误码很误导：`tuwunel` 把「这个房间现在写不进去」的各种情况都归到它名下，真实原因往往和 extremities 毫无关系。按顺序看：

1. **房间号的两种写法**。`tuwunel` 的 `/joined_rooms` 返回的可能是 `!opaque`（不带 `:server`），而模型手里常常是完整号 `!opaque:server`。拿完整号去发，服务端不认。0.4.8 起会自动按 `!` 后面那段对回本地房间表；更早的版本可以把 `roomId` 换成面板「房间」里显示的那个。
2. **换过设备，但加密库没换**。新令牌配旧身份，服务端那边压根没有这台新设备，发什么都不对。0.4.3 起启动时会校验 `data/matrix/crypto/<账号>/device.txt`，对不上就把旧库挪成 `<账号>.old-<时间戳>` 再按新设备重建。
3. **服务端数据本身坏了**（房间的 DAG 索引没了）。换一个新房间试：新房间正常就说明那个旧房间废了，只能重建服务端数据。

### 加密消息一直解不开

日志里看到 `收到 to-device … m.room_key.withheld` 或 `to-device 解不开 code=m.no_olm`，就是对方建不起 Olm 通道，密钥根本没送过来。先按顺序排：

1. **同一账号是否在两处同时跑**。一个 device id 只能有一份加密库，两边都用同一个令牌时，服务端登记的 device keys 会被来回覆盖，另一台机器签的 one-time key 就全成了废签名。
2. **服务端留着旧私钥签的 OTK / fallback key**。表现最典型：OTK 数量看着正常甚至很多，`claim` 回来却验签失败。用 `/_matrix/client/v3/keys/claim` 拿一把 OTK，用它自己的 `ed25519:<device>` 公钥验签就能确认。0.4.3 起加密库会跟着设备自动换（启动时校验 `device.txt`），所以重建之后补上来的 OTK 签名就是对的；升级前的老版本需要手动把 `data/matrix/crypto/<账号>` 挪走再重登。
3. **对方的客户端把设备列表解析失败了**。`/keys/query` 里只要有一条签名不是合法 base64，整个`DeviceKeys` 就解析不出来，对方会当作你没有设备，一个密钥都不发，而且不会提示「设备密钥已改变」。验一遍自签名即可确认。
4. 都正常还解不开，就让对方把客户端彻底重启一次，它会重拉 `/keys/query`。

不用面板也能直接验：

```powershell
cd cortico-world-matrix
corepack pnpm probe            # 只读：版本、账号、房间、sync、媒体下载
corepack pnpm probe -- --send  # 再发一条消息并撤回
corepack pnpm probe:world      # 用真实服务器把整个 World 跑一遍，事件打印出来
```

## 命令

```powershell
cd cortico-world-matrix
corepack pnpm run build          # 面板产物 dist/webui.js
corepack pnpm exec vitest run    # 测试
corepack pnpm exec tsc --noEmit && corepack pnpm exec tsc -p tsconfig.web.json --noEmit
```

契约校验要回到 Cortico 检出：

```powershell
cd "<Coopanion 源码>\vendor\cortico"
corepack pnpm check:extension "cortico-world-matrix"
```

改了工具、事件或环境提示词之后重跑 `pnpm describe:extension <包目录>` 更新 `describe.json`，否则 `tests/manifest.test.ts` 会失败。