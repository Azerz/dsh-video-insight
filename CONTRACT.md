# dsh-video-insight 内部契约（host ⇄ 浏览器半）

host 半在 profile 的 webServer 上挂一个同源前缀路由 `/dsh-video/api`，
浏览器半只用 `fetch` 打这个前缀，不直接联网、不持有凭证。

浏览器半的基址：

```js
const API_BASE = new URL('dsh-video/api/', document.baseURI).toString();
```

## GET /status

```json
{ "ok": true, "value": {
  "version": "0.8.2",
  "model": { "provider": "opencode-go", "model": "deepseek-v4.1-flash" },
  "bilibili": { "cookie": false },
  "platforms": { "youtube": true, "bilibili": true },
  "transcriptLimitChars": 60000,
  "asr": { "enabled": true, "ready": true, "engine": "auto",
           "activeEngine": "whisper", "engineLabel": "Whisper（whisper.cpp）",
           "downloadReady": true }
} }
```

## GET /resolve?url=<链接>&force=1

成功：

```json
{ "ok": true, "value": VideoDoc }
```

`VideoDoc` 可能带一个 `analysis` 字段（之前生成过总结/章节/导图/对话时）：见下方「分析缓存」。

失败（HTTP 仍是 200，看 ok）：

```json
{ "ok": false, "code": "bad-url", "error": "无法识别的视频链接" }
```

`code` ∈ `bad-url` | `fetch-failed` | `not-found` | `unsupported` | `internal`。

### VideoDoc

```json
{
  "platform": "bilibili" | "youtube",
  "docId": "bilibili:BV1xx411c7mD",
  "id": "BV1xx411c7mD",
  "url": "https://www.bilibili.com/video/BV1xx411c7mD",
  "title": "标题",
  "author": "UP 主 / 频道名",
  "authorAvatar": "https://... | null",
  "cover": "https://... | null",
  "duration": 213,
  "publishedAt": "2024-05-01T12:00:00.000Z | null",
  "description": "简介纯文本",
  "stats": { "views": 12345, "likes": 678, "comments": 90, "favorites": 12, "danmaku": 34 },
  "pages": [ { "index": 1, "title": "P1 标题", "duration": 213 } ],
  "officialChapters": [ { "title": "章节名", "start": 0 } ],
  "transcript": {
    "available": true,
    "source": "bilibili-ai-subtitle" | "bilibili-subtitle" | "youtube-caption" | "youtube-asr"
            | "local-whisper" | "local-sensevoice" | "frame-ocr" | "frame-vision" | "none",
    "engine": "whisper | sensevoice（仅本地转写时有）",
    "engineLabel": "Whisper（whisper.cpp）（仅本地转写时有）",
    "tookMs": 90638,
    "cached": true,
    "lang": "zh-CN",
    "chars": 12345,
    "segments": [ { "start": 0, "end": 2.5, "text": "一句话" } ]
  },
  "officialSummary": {
    "summary": "B 站官方 AI 摘要",
    "outline": [ { "title": "小节名", "start": 0 } ]
  },
  "warnings": [ "未登录 B 站：拿不到 AI 字幕与官方总结，可去「设置」粘贴 Cookie" ]
}
```

- `transcript.segments` 按时间升序；`start`/`end` 单位秒（小数）。
- `officialSummary` 可以为 `null`。
- `platform` 之外的字段可能为 `null`（例如没有封面的 YouTube 视频）。
- `stats` 里缺失的字段省略。

## POST /analyze（SSE 流）

请求体：

```json
{ "docId": "bilibili:BV...", "url": "可选，docId 没命中缓存时用",
  "mode": "summary" | "ask", "question": "追问内容（mode=ask）",
  "history": [ { "role": "user" | "assistant", "text": "…" } ] }
```

响应 `content-type: text/event-stream`，每帧一行 `data: <json>` + 空行：

```
data: {"type":"phase","text":"正在读取字幕"}

data: {"type":"delta","text":"## 一句话总结\n"}

data: {"type":"done","text":"完整文本…","usage":{"input":1,"output":2},
       "citations":[{"start":375,"end":401,"preview":"字幕原文…","score":9.51}]}

data: {"type":"error","message":"模型调用失败：…"}
```

- 流只有一次结束（`done` 或 `error`），之后断开。
- `delta` 只带新增文本，客户端自己拼接。
- 客户端用 `fetch` + `response.body.getReader()` 读，不能假设一定成功的 EventSource。
- `mode=ask` 是 RAG 问答：host 先从转写稿召回相关段落（BM25，繁→简归一化），只把这几段连同元信息喂给模型；
  `done.citations` 是这次实际召回的字幕窗口（`start/end` 秒，`preview` 原文片段，`score` BM25 分数），
  面板渲染成「依据」并支持点击 seek。总结 (`mode=summary`) 的 `citations` 是空数组。
- 总结 (`mode=summary`) 的 `done` 帧还带 `suggestions: string[]`（模型在正文末尾写的「继续追问」三条，host 已从 `text` 里剥掉，只在这里和缓存里给）。
- host 会自动持久化结果：summary 成功写 `summary`（含 `suggestions`）；ask 成功把「用户问题 + 助手回答（含 citations）」追加进 `chat`。

## POST /chapters

生成成功后 host 会把章节写进该视频的分析缓存（见「分析缓存」）。

```json
{ "docId": "bilibili:BV...", "url": "可选" }
```

```json
{ "ok": true, "value": { "chapters": [
  { "start": 0, "title": "开场与结论", "gist": "一句话讲这节在说什么" }
] } }
```

## GET /mindmap?docId=<docId>&force=1

从字幕（或本地转写）生成思维导图树，非流式一次返回。首次调用约 8-12 秒，
之后同一视频命中内存缓存（LRU 32，按「文档 + 字幕指纹」失效），`force=1` 重新生成。

```json
{ "ok": true, "value": {
  "docId": "youtube:iG9CE55wbtY",
  "mindmap": {
    "title": "学校会扼杀创造力吗",
    "children": [
      { "title": "开场与三大主题", "children": [ { "title": "创意让我们意识到未来不可预知" } ] }
    ]
  },
  "source": "llm",
  "generatedAt": 1770000000000,
  "cached": false
} }
```

- 树层级：根 → 一级主题（6-10 个）→ 二级要点（每个 2-4 个），最多 3 层；节点只有 `title` 与可选 `children`。
- 没有字幕/转写时：`{ "ok": false, "code": "no-transcript", "error": "…" }`，面板提示先生成文字稿。
- 其它错误码：`llm-failed`、`llm-empty`、`bad-json`（模型没吐出合法 JSON，可重试）、`bad-url`。
- 生成结果会写进分析缓存；之后（包括 host 重启后）`?docId=` 命中磁盘缓存直接返回
  `{ "source": "cache", "cached": true }`，不再调模型。

## POST /credentials

```json
{ "bilibiliCookie": "SESSDATA=xxxx; bili_jct=yyyy" }
```

```json
{ "ok": true, "value": { "bilibili": { "cookie": true } } }
```

空字符串表示清除。凭证写 `~/.dsh/video-credentials.json`（0600）。

## 本地语音转写（ASR）

没有字幕时，host 半可以在这台电脑上转写视频音轨（音频不出本机）。组件探测结果缓存 30 秒。

`GET /asr/status`（`?fresh=1` 跳过缓存）：

```json
{ "ok": true, "value": {
  "enabled": true, "engine": "auto", "engineLabel": "Whisper（whisper.cpp）",
  "activeEngine": "whisper", "ready": true, "downloadReady": true,
  "hints": [],
  "privacy": "语音转写与画面文字识别完全在本机运行；画面理解会把抽样的画面图片发给当前模型（会离开本机）；摘要使用当前配置的模型。",
  "ocr": {
    "available": true, "enabled": true, "label": "画面文字（macOS Vision）",
    "platform": "darwin", "reason": "", "note": "首次使用时会自动编译一次系统文字识别小工具（约 10-20 秒）。"
  },
  "vision": {
    "label": "画面理解（视觉模型）", "mode": "auto", "enabled": true,
    "available": true, "provider": "opencode-go", "model": "deepseek-v4.1-flash",
    "routeLabel": "opencode-go/deepseek-v4.1-flash", "supportsImage": true,
    "reason": "", "candidates": [],
    "config": { "frameMode": "auto", "visionModel": "", "visionMaxFrames": 48, "visionPack": "sheet", "sheetCols": 3, "frameSampling": "cuts", "cutThreshold": 27 },
    "privacy": "画面理解会把抽出来的画面图片交给当前模型（会离开本机）；OCR 仍然完全在本机运行。"
  },
  "config": {
    "threads": 0, "maxSeconds": 0, "keepAudio": false, "autoTranscribe": true,
    "ocrFallback": true, "ocrIntervalSeconds": 8, "ocrMaxFrames": 120, "frameSampling": "cuts", "cutThreshold": 27,
    "frameMode": "auto", "visionModel": "", "visionMaxFrames": 48
  },
  "tools": {
    "ffmpeg": { "available": true, "path": "/opt/homebrew/bin/ffmpeg" },
    "ffprobe": { "available": true, "path": "…" },
    "ytdlp": { "available": true, "path": "…" },
    "whisper": { "available": true, "path": "…" },
    "sherpa": { "available": true, "path": "…" }
  },
  "models": {
    "whisper": { "path": "~/.dsh/video-models/ggml-large-v3-turbo-q5_0.bin", "available": true },
    "sensevoice": { "modelPath": "…model.int8.onnx", "tokensPath": "…tokens.txt", "available": true }
  },
  "engines": {
    "whisper": { "available": true, "label": "Whisper（whisper.cpp）" },
    "sensevoice": { "available": true, "label": "SenseVoice（sherpa-onnx）" }
  }
} }
```

`POST /asr/config`（可以平铺，也可以包在 `asr` 里；写 `~/.dsh/video-credentials.json` 的 `asr` 键，立即生效）：

```json
{ "enabled": true, "engine": "auto|whisper|sensevoice",
  "threads": 0, "maxSeconds": 0, "keepAudio": false, "autoTranscribe": true,
  "ocrFallback": true, "ocrIntervalSeconds": 8, "ocrMaxFrames": 120, "frameSampling": "cuts|uniform", "cutThreshold": 27,
  "frameMode": "auto|ocr|vision", "visionModel": "provider/model 或空",
  "visionMaxFrames": 48, "visionPack": "sheet|frames", "sheetCols": 3 }
```

返回与 `GET /asr/status` 相同的 `value`（fresh）。

`POST /transcribe`（SSE）：

```json
{ "docId": "bilibili:BV...", "url": "可选", "force": false }
```

```
data: {"type":"phase","text":"正在下载音频…"}
data: {"type":"progress","percent":42,"stage":"transcribe"}
data: {"type":"done","docId":"bilibili:BV...","transcript":{ …VideoDoc.transcript… },"cached":false}
data: {"type":"error","code":"asr-needs-ytdlp","message":"…"}
```

- 已有字幕且 `force` 不为真时立即返回 `done` + `cached: true`。
- 本地转写结果持久化在 `~/.dsh/video-transcripts/<docId>.json`：不带 `force` 时直接复用，`/resolve` 对没有字幕的视频也会自动挂上（`transcript.cached: true`），所以解析缓存过期后无需重跑几分钟的识别。
- `percent` 可能为 `null`（下载阶段没有进度），客户端应显示不确定进度。
- 成功后 host 会把新 `transcript` 写回解析缓存，后续 `/analyze`、`/chapters` 直接用。
- `code` ∈ `asr-disabled` | `asr-no-tools` | `asr-needs-ytdlp` | `asr-download-failed` | `asr-convert-failed` | `asr-failed` | `asr-empty` | `ocr-unavailable` | `ocr-needs-ytdlp` | `ocr-no-ffmpeg` | `ocr-frames-failed` | `ocr-download-failed` | `ocr-failed` | `vision-unavailable` | `vision-no-model` | `vision-failed` | `sheet-empty` | `sheet-failed` | `aborted` | `bad-url` | `internal`。

### 转写流程（host 内部）

1. yt-dlp 下音轨（B 站无 yt-dlp 时退回 `x/player/playurl?fnval=16` 的 DASH 直链）；
2. ffmpeg → 16kHz 单声道 wav（`maxSeconds` 可截断）；
3. whisper.cpp（`-oj` JSON）或 sherpa-onnx SenseVoice（一行 JSON，按标点聚合成段）；
4. 结果 < 8 字（含 whisper 的 `*music*` 等非语音占位）抛 `asr-empty`；临时目录删掉（`keepAudio` 时保留 `~/.dsh/video-models/last-audio.*`）。
5. **画面兜底（OCR + 画面理解）**：音轨下载失败或识别出的都是 `*music*` 这类非语音时，进入画面管线：
   - yt-dlp 下 480p 视频 → 抽帧：
     - `frameSampling: cuts`（默认）：ffmpeg 把画面缩到 64×36、4fps 出 rawvideo，逐帧算 RGB 差分分数并做暗场增益，取「一帧的尖峰」（分数 ≥ `cutThreshold` 且 ≥ 邻域中位数 ×2.2）当镜头切点（阈顶 6–40、默认 27）；再按「每段镜头一张」排队——镜头比配额多时把时间轴等分成 N 段、每段取覆盖最长镜头的中点；镜头 <6 个（静态/口播）时均匀铺满。抽帧用 `-ss <秒>` 一次性定位，一张图一个进程。
     - 切不到切点或切分失败：退回 `frameSampling: uniform`，即每 `ocrIntervalSeconds` 秒抽一帧（最多 `ocrMaxFrames` 帧）。
   - `ocrFallback` 为真且有本机 Vision 时，先离线识别画面文字（本机完成）；
   - `frameMode`：`ocr` 只用本机文字识别；`vision` 直接把抽样子集（最多 `visionMaxFrames` 帧）交给支持图片输入的模型描述画面；`auto`（默认）先跑 OCR，平均每帧文字不足 4 字时再加一轮画面理解；
   - `visionPack`：`sheet`（默认）把这批帧用 ffmpeg `tile` 拼成一张分镜图（`sheetCols` 列、行数向上取整），提示里带「第几格 = 第几秒」对应表，模型只收一张图；拼图或解析失败时自动回落到 `frames`（逐帧发送，每批 4 张）；
   - 分镜拼图不落盘、不画字（时间标签走提示词对应表），面板上由前端按同一份 layout 画角标；
   - 合并成带时间戳文字稿：有视觉描述时 `source = "frame-vision"`（`engine = "vision"`），只靠文字时 `source = "frame-ocr"`（`engine = "vision-ocr"`），结构与语音转写一致；
   - 视觉模型由 `visionModel`（`provider/model`）指定，留空则用当前会话默认模型；默认模型没有声明 `image` 输入能力时 `vision.available=false` 并给出候选模型提示。`/resolve` 对这类视频同样会自动挂上持久化结果，并把「没有可用字幕」的警告换成「已使用本地画面文字识别稿（OCR）」/「已使用本地画面理解稿」。

## 历史记录（最近 20 条）

`GET /history`：

```json
{ "ok": true, "value": { "items": [
  { "docId": "youtube:iG9CE55wbtY", "url": "https://www.youtube.com/watch?v=iG9CE55wbtY",
    "platform": "youtube", "id": "iG9CE55wbtY", "title": "Do schools kill creativity?",
    "author": "TED", "duration": 1203, "cover": "https://i.ytimg.com/…",
    "hasTranscript": true, "analyzedAt": "2026-11-06T10:44:14.617Z",
    "action": "analyze" }
] } }
```

- 新的在前，最多 20 条；同一 `docId` 只保留一条（再次解析会把时间刷新并提到最前）。
- `action` = `view`（只解析过）或 `analyze`（生成过总结/追问过）。
- 记录时机由 host 自动完成：`/resolve` 成功记 `view`，`/analyze` 成功记 `analyze`。
- 只存摘要，不存字幕；文件 `~/.dsh/video-history.json`。
- item 还会带分析缓存标记：`hasSummary`、`hasChapters`、`hasMindmap`、`chatCount`（没有缓存时分别为 false/false/false/0）。

`POST /history/remove`，body `{ "docId": "…" }`；`POST /history/clear`。两者都返回 `{ "ok": true, "value": { "items": [...] } }`。

## 检索增强问答（RAG）

追问（`POST /analyze` mode=ask）不再是「整篇字幕塞给模型」，而是两段式：

1. **召回**：把转写稿按 ~140-320 字 / 6 秒静音切成窗口；对「问题 + 上一轮问题（短追问时）」做 BM25 检索，
   取最相关的 8 个窗口，时间上重叠超过 50% 的只保留得分高的。
   - 中文按 bigram 切词，英文/数字按词；检索前把文本做繁→简归一化（`lib/zh.js`，OpenCC TSCharacters，
     3221 对单字映射），因为 YouTube 中文（台湾）字幕常是繁体，用户问题多是简体。
2. **生成**：只把召回窗口（带 `[mm:ss-mm:ss]`）+ 视频元信息 + 最近 6 轮对话喂给模型，
   要求回答用 `[mm:ss]` 标注来源；`done.citations` 返回召回窗口给面板做跳转。

转写稿太长但没召回到相关内容时，prompt 会明确要求「说没有提到，不要编」。
检索索引在内存 LRU（8 份，按 docId + 字幕指纹失效），首次追问会多花几十毫秒切窗。

## 分析缓存

按视频缓存「总结 / 章节 / 思维导图 / 对话」，从「历史」里点回来时不用重新生成。

存放：`~/.dsh/video-analyses/<docId>.json`（一个视频一个文件，原子写入，权限 0600）。
结构：

```json
{
  "version": 1,
  "docId": "youtube:iG9CE55wbtY",
  "savedAt": 1770000000000,
  "doc": { "title": "…", "author": "…", "duration": 1203, "cover": "https://…",
           "publishedAt": "…", "description": "…", "stats": {...}, "pages": [...],
           "hasTranscript": true },
  "summary":  { "text": "Markdown…（已去掉「继续追问」小节）", "usage": {...}, "suggestions": ["建议追问 1", "建议追问 2", "建议追问 3"], "generatedAt": 1770000000000 },
  "chapters": { "items": [ { "start": 0, "title": "…", "gist": "…" } ],
                "source": "llm", "generatedAt": 1770000000000 },
  "mindmap":  { "mindmap": { "title": "…", "children": [...] }, "generatedAt": 1770000000000 },
  "chat": [ { "role": "user", "text": "问题", "citations": [], "at": 1770000000000 },
            { "role": "assistant", "text": "回答", "citations": [ {"start":375,"end":401,"preview":"…"} ], "at": 1770000000000 } ]
}
```

- 写入时机：`/resolve` 成功刷新 `doc`；总结成功写 `summary`；`/chapters` 成功写 `chapters`；
  `/mindmap` 成功写 `mindmap`；追问成功追加一问一答到 `chat`（最多 40 条）。
- 时间字段（`savedAt` / `generatedAt` / `at`）都是 **epoch 毫秒数字**；`/history` 里的 `analyzedAt` 仍是 ISO 字符串（历史文件既有格式）。
- `GET /resolve` 时如果该视频有缓存，会把 `analysis` 挂到 `VideoDoc`：
  `{ savedAt, summary, chapters, mindmap, chat }`，没有缓存时字段不存在。
- `GET /analysis?docId=<docId>` → `{ ok: true, value: { docId, analysis } }`（单独取，`analysis` 可能为 null）。
- `POST /analysis/clear`，body `{ docId }`：删掉该视频的全部缓存（总结/章节/导图/对话）。
- `POST /analysis/chat/clear`，body `{ docId }`：只清对话。
- 字幕不重复存进分析缓存：平台字幕随 `/resolve` 重新抓取，本地转写稿在 `~/.dsh/video-transcripts/<docId>.json`。

## 播放器外壳（host 提供）

（客户端把 `/mindmap` 返回的树渲染成 SVG 图形化横向树：节点卡片 + 三次贝塞尔连线、按一级分支配色、点节点折叠，纯前端布局，不影响接口契约。总结正文、追问回答里的 `[mm:ss]` 也渲染成可点击徽标，点击走同一套 `{type:'dsh-video:seek'}` 外壳协议跳转并播放。）

桌面客户端的主界面跑在自定义协议 `dsh-app://app` 下，面板里直接嵌 YouTube iframe 会被拒绝播放（父页面不是 http(s) 起源、也不会发送 http Referer）。所以由 host 提供一个 http 起源的外壳页，面板只嵌外壳：

- `GET /player?platform=youtube|bilibili&id=<id>&page=<n>&start=<秒>` → `text/html`（`cache-control: no-store`、`referrer-policy: strict-origin-when-cross-origin`；参数非法返回 400）。
- 外壳内再嵌真正的播放器：
  - YouTube：用官方 IFrame Player API（`https://www.youtube.com/iframe_api` + `new YT.Player(...)`，`playerVars.start` 传起始秒数）。接口自动带正确 origin，`player.seekTo(秒, true)` + `player.playVideo()` 可靠；
  - 哔哩哔哩：`https://player.bilibili.com/player.html?bvid=<BV>&page=<p>&autoplay=0&danmaku=0&as_wide=1&high_quality=1&poster=1`，有起始秒数时再带 `&t=<秒>`；seek 时重建内层 src，并且 `autoplay` 只出现一次（`&autoplay=1`）；早先「先写 `autoplay=0` 再追加 `&autoplay=1`」会因重复参数取第一个而变成 0，表现为「跳了进度但不自动播放」。
- seek：面板向外壳 iframe `postMessage({type:'dsh-video:seek', seconds})`；外壳先排队到播放器就绪，再 `seekTo(秒, true)` + `playVideo()`（哔哩哔哩重建内层 src 带 `t` 与 `autoplay=1`）——点时间戳即跳到对应位置并开始播放。
- 初始定位只用 URL 上的 `start` 参数；**不要**在 iframe 首次加载时主动发 seekTo（实测会在播放器就绪前黑屏），seekTo 只在用户点时间戳时发。
- 外壳加载完成会向 parent 发 `{type:'dsh-video:wrapper'}`，面板可据此补发 pending seek。
## 分镜（storyboard）

把视频按**镜头切点**抽帧、拼成一张带时间戳的分镜拼图，供面板「分镜」页签显示、点格子 seek。图片与元数据按视频缓存在 `~/.dsh/video-storyboards/`：

- 文件：`<safeId(docId)>.jpg`（拼图）+ `<safeId(docId)>.json`（元数据）。`safeId` 把非 `[A-Za-z0-9_-]` 字符换成 `_`，截 160 字符。清掉任意一个即视为没有缓存。
- 生成流程（host 内部）：`captureFrames`（yt-dlp 下 ≤480p、ffmpeg 4fps 64×36 rawvideo 扫切点、按镜头取 ≤24 帧）→ `buildContactSheet`（ffmpeg `tile` 拼 3 列 × 自动行数，格子 512×288）→ 复制 jpg 落盘 →（可选）`describeSheet` 让视觉模型逐格描述并把 `description` 合并进 cells → 原子写 JSON。
- JSON 形状：
  ```json
  {
    "docId": "youtube:aqz-KE-bpKQ", "url": "…", "title": "…", "platform": "youtube",
    "duration": 634, "generatedAt": 1794981000000, "tookMs": 9200,
    "frameSampling": "cuts", "cuts": 146, "frames": 24,
    "cols": 3, "rows": 8, "cellWidth": 512, "cellHeight": 288, "described": false,
    "cells": [{"index": 1, "row": 0, "col": 0, "seconds": 8}, {"index": 2, "row": 0, "col": 1, "seconds": 33.38}]
  }
  ```
  `seconds` 是该格画面的绝对秒数（它在原视频里的时间），`row/col` 从 0 开始。有 `describe` 时每格多一个 `description`（≤160 字）。
- `GET /storyboard?docId=<docId>` → `{ok:true, value:<上面的对象>|null}`；缓存缺失/损坏返回 `value:null`。
- `GET /storyboard/image?docId=<docId>` → `image/jpeg`（`cache-control: no-store`）；没有缓存时 `404 {ok:false,code:'not-found'}`。客户端要用 `?v=<generatedAt>` 破缓存。
- `POST /storyboard/clear` body `{docId}` → `{ok:true}`（删 json + jpg）。
- `POST /storyboard`（SSE）body `{docId?/url?, frames?:24, cols?:3, describe?:boolean, force?:boolean}`：
  - 未 force 且已有缓存、且（没要 `describe` 或缓存本来就 `described`）→ 直接 `done cached:true`；
  - 帧：`{type:'phase',text}`、`{type:'progress',stage:'download'|'scan'|'frames',percent}`、`{type:'done',cached:false,docId,storyboard}`、`{type:'error',code,message}`；
  - 错误码：`bad-url`、`unsupported`、`ocr-needs-ytdlp`、`ocr-no-ffmpeg`、`ocr-empty`、`sheet-empty`、`sheet-failed`、`vision-*`、`aborted`、`internal`。
- 说明：分镜不依赖字幕（无字幕/无声视频也能出图）；`describe` 会调用视觉模型（图片会离开本机），不开时纯本机处理。

## 字幕双语文档（translate）

把转写稿逐段翻译成中文/英文，时间轴保持不变，供面板「原文」页签做对照显示。结果按视频 + 语言缓存在 `~/.dsh/video-translations/<safeId(docId)>.<lang>.json`（0600，原子写）。

- 只支持 `zh` / `en`（`lang` 其他值 → `bad-lang`）。
- 输入是 `doc.transcript.segments`（平台字幕、本地 Whisper、OCR、画面理解都行）；没有转写稿 → `no-transcript`。
- 分批：每批 ≤40 段且 ≤3200 字（`BATCH_SEGMENTS` / `BATCH_CHARS`）；每批让模型只输出与输入等长的 JSON 字符串数组，`parseTranslations` 取第一个 `[` 到最后一个 `]` 解析，多截少补。
- `video.transcript` 上限 6000 段（`MAX_TRANSLATIONS`）。
- 缓存文件形状：
  ```json
  { "docId": "youtube:dQw4w9WgXcQ", "lang": "zh", "langLabel": "中文", "source": "llm",
    "model": "deepseek-v4.1-flash", "createdAt": 1794983000000, "count": 61,
    "translations": [{"start": 18.64, "end": 22.4, "text": "♪ We're no strangers to love ♪", "translation": "♪ 我们对爱早已不陌生 ♪"}] }
  ```
- `GET /translate?docId=<docId>&lang=zh|en` → `{ok:true,value:<上面的对象>|null}`（`value.cached=true`）。
- `POST /translate`（SSE）body `{docId?/url?, lang:'zh'|'en', force?}`：
  - 帧：`{type:'phase',text}`、`{type:'progress',stage:'translate',percent}`、`{type:'done',docId,lang,langLabel,cached,count,translations}`、`{type:'error',code,message}`；
  - 未 `force` 时命中缓存直接 `done cached:true`；
  - 错误码：`bad-lang`、`no-transcript`、`bad-json`、`no-route`、`llm-failed`、`aborted`、`internal`。
- `POST /translate/clear` body `{docId, lang}` → `{ok,value:{docId,lang,removed}}`。
- 播放进度同步（「跟随播放」用）：播放器外壳页面每秒向父页面 `postMessage({type:'dsh-video:time', seconds})`（YouTube IFrame API 有 `getCurrentTime()`；B 站 iframe 跨域拿不到，不发）。面板据此把当前播放时间映射到段落并高亮，只在用户点开「原文」页签时才滚动。

- 节点可带可选 `t`（整数秒）：该主题在视频里对应的时间点，由模型按字幕时间戳判断，服务端夹到 `[0, duration]`；面板把 `t` 渲染成可点的时间徽标，点了跳播放位置。没有 `t` 的节点不显示徽标。

## 素材缓存（assets）

抽帧相关的功能（画面文字识别、画面理解、分镜）共用同一条视频的下载与切点扫描结果，按视频缓存在：

```
~/.dsh/video-assets/<safeId(docId)>/video.<ext>   低清视频（≤480p，无音轨）
~/.dsh/video-assets/<safeId(docId)>/video.json    元信息（bytes / duration / downloadedAt）
~/.dsh/video-assets/<safeId(docId)>/cuts.json     镜头切点（duration / threshold 变了才失效）
```

- 清理策略：按目录 LRU，最多 8 个视频、总大小 ≤2GiB、30 天未访问删除。
- `GET /dsh-video/api/assets?docId=<docId>` → `{ok,value:{video:{bytes,duration,downloadedAt},cuts:{count,threshold,createdAt}}}`（没有缓存时 `value:null`）。
- `POST /dsh-video/api/assets/clear` body `{docId}` → `{ok,value:{docId,cleared}}`。
- 命中缓存时 SSE 的 phase 会写「复用已经下载好的低清视频…」「复用上次扫到的 N 个镜头切点…」。

## 关键画面（keyframes）

`GET /dsh-video/api/keyframes?docId=<docId>&count=16` → `{ok,value:{docId,duration,items:[{seconds,label}]}}`。

- 取点顺序：分析缓存里的章节（`analysis.chapters.items`）→ `doc.officialChapters` → 缓存的镜头切点（`cuts.json`，等步长抽样）→ 均匀铺满（最多 24 个）。
- `count` 夹在 6–36；视频没解析过返回 `{ok:false,code:'not-found'}`。
- 缩略图仍需配合 `GET /thumb` 逐张取（客户端懒加载）。

## 历史收藏

`POST /dsh-video/api/history/favorite` body `{docId, favorite}` → `{ok,value:{items}}`（items 与 `GET /history` 同形，`favorite` 布尔）。重新解析同一视频不会覆盖已有收藏状态。

## 画面缩略图（thumb）

从缓存的低清视频按秒截一帧，给章节列表 / 关键画面用：

- `GET /dsh-video/api/thumb?docId=<docId>&seconds=<秒>&w=320` → `image/jpeg`（默认 320 宽、等比缩放，`cache-control: private, max-age=86400`）。
- 也接受 `url=<链接>` 代替 `docId`（未命中解析缓存时现场解析）；视频缓存不存在时会先下载一次 480p（phase 不可见，耗时约 5–20s）。
- 截图缓存在 `~/.dsh/video-assets/<docId>/thumbs/<秒>.jpg`，与视频缓存同生命周期。
- 错误：`{ok:false,code:'not-found'|'thumb-failed'|'ocr-no-ffmpeg',error}`。
- 首次截图约 100ms，命中缓存约 20ms（320×180，4–5KB）。

## 章节大纲与画面描述（outline）

章节页签与关键画面页签共用同一份「大纲」，优先用思维导图的一级节点（导图节点带模型定位的 `t` 秒），保证章节与导图一致：

```
GET /dsh-video/api/outline?docId=<docId>
→ {ok,value:{docId,duration,source:'mindmap'|'chapters'|'uniform',signature,
             visuals:{generatedAt,provider,model,described}|null,
             items:[{seconds,title,detail:[...],description}]}}
```

- 取点顺序：`analysis.mindmap`（≥3 个一级节点）→ 分析缓存里的章节 → 视频官方章节 → 均匀铺（最多 16 条）。
- `POST /dsh-video/api/outline/visuals`（SSE，body `{docId?|url?, force}`）：抽帧（按大纲秒数）→ 拼成一张图 → 视觉模型逐格描述（`source` 与导图/章节返回一致）；帧 `phase` / `progress` / `done{items,cached,usage}` / `error{code,message}`。
- 结果按 `(docId, 大纲签名)` 缓存在 `~/.dsh/video-outlines/<safeId>.json`，章节与关键画面共用；大纲变了（重新生成导图）缓存自动失效。
- `GET /dsh-video/api/thumb?docId=&seconds=&w=320` 提供章节缩略图（`image/jpeg`，按视频缓存在 `~/.dsh/video-assets/<docId>/thumbs/`）。
- `POST /dsh-video/api/outline/clear` body `{docId}` 清掉缓存的画面描述。
- 思维导图节点的时间点会随分析缓存持久化（`analysis.mindmap` 保留 `t`），刷新页面后徽标仍在。

## 工具（agent-facing）

插件在 `ctx.inject(['tools'])` 里注册两个**全局**工具（fiber 不是 agent scope，所以任何会话——包括 qqbot 用 `ctx.agents.create()` 起的 QQ 会话——都看得见）：

| 名称 | 参数 | 返回 |
| --- | --- | --- |
| `video_digest` | `url`(必填) / `question` / `maxChars`(400-4000，默认 1800) | 一段可直接转述的中文摘要文本 |
| `video` | `action`(resolve/transcribe/summary/ask) / `url`(必填) / `question` / `maxChars` | 文本 |

`video_digest` 的文本结构：`《标题》` / `平台 · 作者 · 时长` / `链接` / `字幕：来源与字数` / （可选）`问：…` / 正文 / `依据：[mm:ss] …` / 官方章节前 8 条 / `注意：warnings`。没有字幕时先本地 ASR，再退画面文字 OCR；两个工具与面板共用 `~/.dsh/video-credentials.json` 里的 B 站 Cookie。工具调用同样会写历史与综合分析缓存：`resolve`/`transcribe` 记 `view`，`summary`/`ask`/`video_digest` 记 `analyze`（summary 与 video_digest 的总结正文还会 `saveSummary` 到 `~/.dsh/video-analyses/`），所以面板「最近分析」与打开视频时的缓存可以直接复用。
