# dsh-video-insight · 视频解析

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4d6bfe.svg)](https://github.com/deepseek-ai)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)](#已知限制)
[![Version](https://img.shields.io/badge/dsh--video--insight-v0.4.8-blue.svg)](package.json)

![dsh-video-insight](icon.svg)

DeepSeek Harness 的视频插件库里的「第二块屏」：左侧栏「知乎浏览」下面是**视频解析**入口，点开是一整页面板：**左栏**上方是内嵌播放器、下方是追问对话框，**右栏**是总结 / 章节 / 原文 / 思维导图。粘贴一条 YouTube 或哔哩哔哩链接，插件自己把字幕抓下来，用你当前的默认模型生成内容；点时间戳直接跳到对应位置，边看边读。左上角「← 返回」：在视频详情页点它回到插件首页（大输入框 + 最近分析），已经在首页时再点才回到会话界面。

没有字幕的视频也不至于没得看：可以用**本机 Whisper / SenseVoice 转写**兜底（可选引擎、线程、只转前 N 秒），音频全程不出这台电脑；**纯无声/纯画面视频**（没有配音也没有字幕）还能抽帧做**画面文字识别（OCR）**，甚至直接把画面交给**视觉模型**描述场景、人物和动作（「画面理解」，会用到支持图片输入的模型），把画面内容变成带时间戳的文字稿，摘要仍用你 profile 里的模型。

追问是 **RAG（检索增强）**：先把问题在转写稿里做 BM25 检索，只把最相关的几段（带时间戳）连同对话一起喂给模型，回答里标 `[mm:ss]`，气泡下面还有「依据」按钮，点一下直接跳回那段视频。

总结 / 章节 / 思维导图 / 对话都会**按视频缓存**（`~/.dsh/video-analyses/`），从「历史」里点回来直接看到上次的结果，不用重新等模型；想重来就点「重新生成」，也可以一键清空某个视频的缓存。

> 参照 BibiGPT 的用法：链接进去，笔记和问答出来。区别是它跑在 DSH 里，用的是你 profile 里已经配好的模型，不额外要 API key。

## 入口与页面

左侧栏 `sidebar.panellist`，`order: 30`（排在「插件」「定时任务」「知乎浏览」之后）。图标是粉色播放键 + 星芒。

首页是 Google 式的**居中大输入框 + 解析按钮**（粘贴链接回车即可），下面是「最近分析」的历史列表（历史区自己内联滚动，不带动整页），点历史项直接回到那个视频；不再有多余的平台介绍卡。解析出视频后才出现顶部的小号输入条，方便随时换一个链接。

| 页签 | 做什么 |
| --- | --- |
| 总结 | 解析完自动流式生成；结构固定为 一句话总结 / 核心观点 / 内容脉络 / 关键要点 / 值得记住的说法 / 适合谁看，引用带 `[mm:ss]` 时间戳——**正文里的时间戳也可点击，点一下播放器跳到该时间点继续播放**。正文末尾还让模型顺手给出 **3 条「继续追问」**（只对本期内容成立的具体问题），host 会把它从正文里剥出来、单存成 `suggestions`，面板在追问空态里渲染成带虚线的 chip |
| 章节 | 模型按时轴切 6–12 章（`POST /chapters` 只吐 JSON）；失败自动回落视频自带的章节 / 分 P |
| 原文 | 字幕逐段列表（`[mm:ss] 文本`），可搜索过滤、点单条复制、一键复制全文 |
| 思维导图 | 模型把字幕整理成 3 层树状大纲（`GET /mindmap`，带缓存），面板渲染成 **SVG 图形化横向树**（节点卡片 + 贝塞尔连线、按分支配色），点节点折叠/展开，支持全部展开/收起、缩放、重新生成 |
| 追问 | 左栏下方对话框：基于转写稿的 RAG 多轮问答（检索相关段落后再回答），回答带 `[mm:ss]`，下方「依据」chip 可点击跳转；对话按视频缓存。空态先给固定三句，再给 **AI 根据本视频总结生成的 3 条建议追问**（虚线 chip，点一下直接问） |
| 设置 | 填 B 站 Cookie（SESSDATA），保存到 `~/.dsh/video-credentials.json`（0600）；可清除 |
| 历史 | 最近 20 条解析/分析记录，存在 `~/.dsh/video-history.json`（跨浏览器、跨重启都在），点击重新打开，可单条删除或清空 |

左栏的**可折叠内嵌播放器**：面板里的 iframe 指向 host 的 `/dsh-video/api/player` 外壳页——桌面客户端主界面跑在 `dsh-app://` 自定义协议下，直接嵌 YouTube 会被拒绝播放，外壳页以 http 起源加载后再嵌真正的播放器：YouTube 走官方 IFrame Player API（`seekTo` + `playVideo`，点时间戳直接跳过去并继续播放），B 站走 `player.bilibili.com`（分 P、`t` 起始秒数都支持，seek 只重载内层 iframe）。章节、原文、思维导图里的时间戳点了会 seek 到对应位置，折叠状态下会先展开再跳。折叠偏好记在 localStorage。窄窗口（<980px）自动改成单列堆叠。

顶部还有「重新生成 / 停止 / 复制」；错误一律是中文可读文案，不抛原始堆栈。

## 数据从哪来（降级顺序）

**YouTube**

1. 抓 `watch` 页，从 `ytInitialPlayerResponse` 取标题、作者、时长、播放、简介、发布日期、章节标记；
2. 字幕走 **ANDROID innertube player**（`youtubei/v1/player`，client `ANDROID/20.10.38`）拿 `captionTracks` 的 `baseUrl`，再下载 `timedtext`（XML `<p t= d=>` 或 json3 都兼容）——WEB 的 timedtext 实测返回空 body，**必须**用 ANDROID 这条；
3. 语言偏好：中文 > 英文，人工字幕优先于 ASR；
4. 无字幕时如实说明「没有字幕，模型只能基于标题/简介/章节分析」。

**哔哩哔哩**

1. `x/web-interface/view` 免登录拿元信息（标题、UP 主、时长、播放/点赞/评论/收藏/弹幕、分 P、简介）；
2. 字幕与官方 AI 总结需要登录 Cookie（`SESSDATA`）：字幕走 wbi 签名版 `x/player/wbi/v2` 的 `subtitle.subtitles[].subtitle_url`，官方总结走 `x/web-interface/view/conclusion/get`；
3. 没 Cookie 时不伪造，只给可读的告警条：拿到不 AI 字幕 / 官方总结，但简介、分 P 标题仍可分析；
4. 接口对并发敏感（同时打几下就 `-352`），插件内做了**全局串行队列** + `buvid3/buvid4` 指纹兜底。

**B 站 Cookie 怎么填**：浏览器登录 bilibili.com → DevTools → Application → Cookies → 复制 `SESSDATA` 的值，粘进面板「设置」。插件会自己拼成 `SESSDATA=...` 并补 `buvid3`。只填 SESSDATA 就够。

## 没有字幕？本地语音转写兜底

有些视频（尤其 B 站 UGC / YouTube 音乐、直播回放）没有字幕轨。面板会显示一条「这个视频没有字幕」的提示条，「本地转写」按钮会走这台电脑上的语音识别：

1. 用 **yt-dlp** 把音轨下载到临时目录（B 站没有 yt-dlp 时退回官方 `playurl` 直链）；
2. 用 **ffmpeg** 转成 16kHz 单声道 wav（可选 `maxSeconds` 只转前 N 秒）；
3. 用 **whisper.cpp**（默认）或 **sherpa-onnx 的 SenseVoice** 识别，结果覆盖 `doc.transcript`，后面的总结 / 章节 / 追问 / 原文直接使用；
4. 临时文件用完即删（`keepAudio: true` 时保留最后一份到 `~/.dsh/video-models/last-audio.*` 便于排查）。转写结果持久化在 `~/.dsh/video-transcripts/<docId>.json`，解析缓存过期后也不会重复跑几分钟的识别。

**隐私**：识别完全在本机完成，音频不会上传到任何服务；只有最终的文字稿会随总结/追问请求发给当前配置的模型。摘要想完全离线，需要本地模型（本插件目前只对接 profile 里的模型服务）。

依赖（都可以 `brew install`，装完在面板「设置 → 本地语音转写」里能看到每项是否可用）：

```bash
brew install ffmpeg yt-dlp whisper.cpp
# Whisper 模型（默认 large-v3-turbo q5_0，约 574MB）
mkdir -p ~/.dsh/video-models && cd ~/.dsh/video-models
curl -L -o ggml-large-v3-turbo-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
# 可选：SenseVoice（sherpa-onnx 预编译包 + 模型）
# https://github.com/k2-fsa/sherpa-onnx/releases 下 osx-arm64 包解压到 ~/.dsh/video-tools/sherpa-onnx/
# 模型 model.int8.onnx + tokens.txt 放到 ~/.dsh/video-models/sensevoice/
```

实测速度（M 系列 Mac）：Whisper large-v3-turbo 约 **RTF 0.12**（10 分钟视频 ≈ 1.5 分钟）；SenseVoice 快 5 倍左右但没有句子级时间戳，插件按标点把 token 聚合成段。

### 连声音都没有？画面文字识别（OCR）+ 画面理解（视觉模型）

纯音乐、无声演示、PPT 录屏这类视频，语音识别只会得到 `*music*`。插件会自动兜底到画面管线：

1. yt-dlp 下载 480p 以内的视频；
2. ffmpeg 每 8 秒抽一帧（可在设置里调 `抽帧间隔` / `最多识别帧数`）；
3. **本机 OCR**：用 macOS 自带的 Vision 框架离线识别中英文文字（首次使用会把一个小工具编译到 `~/.dsh/video-tools/ocr/`，约 10-20 秒，之后复用），完全不出本机；
4. **画面理解（可选）**：把抽样的若干帧（默认最多 48 帧）作为图片交给支持图片输入的模型，让它描述画面里的场景、人物/物体、动作和画面文字；默认 `frameMode: auto` 时，只有 OCR 平均每帧不足 4 字（比如纯动画、vlog）才追加这一轮；
5. 合并成带时间戳的文字稿：有画面描述时 `source: frame-vision`（视觉模型），只有本机文字时 `source: frame-ocr`；后续总结、章节、思维导图、追问都能用。

**隐私差别**：OCR 完全在本机；画面理解会把抽出来的画面图片发给当前模型（`visionModel` 留空即用会话默认模型，当前模型需声明 `image` 输入能力，否则面板会给出候选模型提示），设置里可以切换成「仅画面文字（OCR）」或关掉整个画面兜底。

识别质量取决于画面清晰度和画面文字；和真实字幕没法比。解析到无字幕视频时**默认会自动开始**这次转写（设置里可关掉「无字幕视频自动转写」）；转写完成后总结 / 章节 / 追问 / 原文全部改用新文字稿。

解析到无字幕视频时**默认会自动开始**这次转写（设置里可关掉「无字幕视频自动转写」）；转写完成后总结 / 章节 / 追问 / 原文全部改用新文字稿。

## 安装

```bash
git clone https://github.com/Azerz/dsh-video-insight.git
```

装进 DSH profile 有两条路：

**① 让 harness 里的 agent 装（最省事）** —— 在任意会话里说「把 `/path/to/dsh-video-insight` 装成插件」，或直接调用插件管理工具 `plugin_manager`：

```jsonc
{ "action": "install_bundle", "target": "/path/to/dsh-video-insight" }
```

安装器会自动把 `"dsh-video-insight": "link:/path/to/dsh-video-insight"` 写进 profile 的 `dependencies`，并把 `"dsh-video-insight"` 追加进 `dsh.profile.bundles`，live profile 立即生效，刷新页面就能看到左侧栏入口。

**② 手工装** —— 编辑 `~/.dsh/profiles/desktop/package.json`：

```jsonc
{
  "dependencies": { "dsh-video-insight": "link:/path/to/dsh-video-insight" },
  "dsh": { "profile": { "bundles": [ /* …, */ "dsh-video-insight" ] } }
}
```

然后在该 profile 目录里 `pnpm install`，重启 App。

装好后确认路由在线：

```bash
curl -s http://127.0.0.1:50231/dsh-video/api/status   # 端口以实际 GUI 为准
```

host 半零外部依赖（只用 Node 内置 `fetch`/`crypto`），不写锁文件、不跑构建。可选依赖（仅本地转写/画面识别需要）：`brew install ffmpeg yt-dlp whisper.cpp`，详见上文。

## 同源 API（面板用，也可自己 curl）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-video/api/status` | `{ok,value:{version,model,bilibili:{cookie},platforms,transcriptLimitChars,asr:{enabled,ready,engine,activeEngine,engineLabel,downloadReady}}}` |
| GET | `/dsh-video/api/resolve?url=&force=1` | 解析链接 → `VideoDoc`（失败也是 HTTP 200 + `{ok:false,code,error}`） |
| GET | `/dsh-video/api/asr/status?fresh=1` | 本地转写组件/引擎/模型状态 + `ocr`（画面文字识别）+ `vision`（画面理解/视觉模型能力）+ `privacy` 文案 + `hints` |
| POST | `/dsh-video/api/asr/config` | `{enabled?,engine?,threads?,maxSeconds?,keepAudio?,autoTranscribe?,ocrFallback?,ocrIntervalSeconds?,ocrMaxFrames?,frameMode?:auto\|ocr\|vision,visionModel?,visionMaxFrames?}` → 新状态 |
| POST | `/dsh-video/api/transcribe` | SSE：`{url?/docId?, force?}`，帧 `phase` / `progress{percent,stage}` / `done{docId,transcript,cached?}` / `error{code,message}`；无语音时自动兜底 OCR / 画面理解（stage 含 `vision`） |
| POST | `/dsh-video/api/analyze` | SSE：`{mode:'summary'\|'ask', url?/docId?, question?, history?}`，帧 `phase` / `delta` / `done` / `error` |
| POST | `/dsh-video/api/chapters` | `{url?/docId?}` → `{ok,value:{chapters:[{start,title,gist}],duration}}` |
| GET | `/dsh-video/api/mindmap?docId=&force=1` | 字幕 → `{ok,value:{docId,mindmap:{title,children[]},source:'llm'\|'cache',generatedAt,cached}}`；无字幕 `code:'no-transcript'`；结果写分析缓存 |
| GET | `/dsh-video/api/player?platform=&id=&page=&start=` | 播放器外壳 HTML：桌面端自定义协议下让 YouTube 能正常内嵌播放，面板 iframe 指向它 |
| POST | `/dsh-video/api/credentials` | `{bilibiliCookie}` 保存；传空串即清除 |
| POST | `/dsh-video/api/credentials/clear` | 清空凭证 |
| GET | `/dsh-video/api/analysis?docId=` | 取某个视频的分析缓存：`{ok,value:{docId,analysis:{summary,chapters,mindmap,chat}}}` |
| POST | `/dsh-video/api/analysis/clear` | `{docId}` 清掉该视频全部缓存（总结/章节/导图/对话） |
| POST | `/dsh-video/api/analysis/chat/clear` | `{docId}` 只清对话 |
| GET | `/dsh-video/api/history` | `{ok,value:{items:[…]}}`，最近 20 条，新的在前（解析/分析成功后 host 自动写入）；带 `hasSummary/hasChapters/hasMindmap/chatCount` 标记 |
| POST | `/dsh-video/api/history/remove` | `{docId}` 删一条 → `{ok,value:{items}}` |
| POST | `/dsh-video/api/history/clear` | 清空历史 → `{ok,value:{items:[]}}` |

`POST /analyze` 的 `done` 帧在 `mode=ask` 时带 `citations: [{start,end,preview,score}]`（RAG 召回的段落）；`GET /resolve` 的 `VideoDoc` 可能带 `analysis` 字段（已有缓存时）。详见 [CONTRACT.md](./CONTRACT.md)。

`VideoDoc` 字段见 [CONTRACT.md](./CONTRACT.md)：`platform/docId/id/url/title/author/authorAvatar/cover/duration/publishedAt/description/stats/pages/officialChapters/transcript{available,source,lang,chars,segments[{start,end,text}]}/officialSummary{summary,outline[]}/warnings`。

## 给助手的工具

插件注册了**两个全局工具**（`ctx.tools.register`，不是 agent scope），所以任何会话——包括 qqbot 用 `ctx.agents.create()` 起的 QQ 会话——都能直接调用，不用额外配置：

| 工具 | 用途 |
| --- | --- |
| `video_digest` | 聊天里首选：`url`（必填）+ 可选 `question`，返回一段可直接转述的中文摘要（标题、作者、时长、链接、字幕来源、六段式总结，或对问题的回答）。`maxChars` 默认 1800 |
| `video` | 需要细节时用：`action=resolve`（元信息 + 带 `[mm:ss]` 的字幕）、`transcribe`（本地语音/OCR 兜底）、`summary`、`ask`（RAG 追问，结果带「依据」时间戳） |

两个工具与面板共用 B 站 Cookie；**通过工具解析/分析的视频也会写进历史记录和综合分析缓存**（动作分别记成浏览/分析，总结会缓存），在面板的「最近分析」里能直接看到并复用。`url` 支持完整链接、`youtu.be` 短链、`b23.tv` 短链、`BV` 号。

## 配置

`cordis.patch.yml` 里可写：

```yaml
- insert:
    - id: video
      name: 'dsh-video-insight'
      config:
        bilibiliCookie: ''      # 也可以（推荐）在面板「设置」里填
        transcriptLimitChars: 60000
        requestTimeoutMs: 20000
        asr:
          enabled: true
          engine: auto          # auto | whisper | sensevoice
          autoTranscribe: true  # 解析到无字幕视频时自动本地转写
          ocrFallback: true       # 连语音都没有时，抽帧做画面文字识别（OCR）
          ocrIntervalSeconds: 8   # 抽帧间隔（秒）
          ocrMaxFrames: 120       # 最多识别帧数
          frameMode: auto         # auto | ocr | vision（画面理解）
          visionModel: ''         # provider/model，留空用会话默认模型
          visionMaxFrames: 48     # 画面理解最多几张画面
```

面板「设置」里保存的 Cookie 与本地转写配置都写在 `~/.dsh/video-credentials.json`，**优先级高于**行配置，改完立即生效。

## 已知限制

- 解析缓存 30 分钟（LRU 24 条）；`force=1` 可强制刷新（分析缓存不受影响，按视频永久保留）。
- RAG 是关键词检索（BM25 + 繁简归一化），不做向量语义检索；问法太抽象或字幕用词差异很大时可能召回不到，此时会直接说「视频里没有提到」。
- 分析缓存不存字幕：平台字幕靠 `/resolve` 重新抓取，本地转写稿单独存在 `~/.dsh/video-transcripts/`。
- YouTube 字幕是定时文本，标点/语气词可能有噪声；滚动字幕的重复窗口已做去重。
- B 站字幕只有「有 Cookie + 该视频确有 AI 字幕」才拿得到，不是每个视频都有。
- 画面文字识别：只在 macOS 可用（依赖系统 Vision 框架）；识别质量取决于画面文字是否清晰，滚动弹幕/花哨字体容易出错；抽帧间隔与帧数上限会限制长视频的覆盖密度。
- 画面理解：需要当前（或设置里指定的）模型声明 `image` 输入能力；会把抽样画面图片发给模型（与 OCR 的本机离线不同）；每帧约 2–4 秒、按帧计费，所以默认只抽最多 48 帧并在 OCR 文字够多时跳过；画面里既没字也没可描述内容时仍会得到 `asr-empty`。
- 本地转写：Whisper 首次加载 574MB 模型约 6–12 秒（每次调用固定成本，长视频占比可忽略）；SenseVoice 段级时间戳是按标点聚合的近似值；`threads: 0` 交给引擎自己决定（whisper.cpp 默认 4）。
- 只支持单条链接，不做播放列表 / 合集递归。

## 开源

- 仓库：[github.com/Azerz/dsh-video-insight](https://github.com/Azerz/dsh-video-insight)
- 协议：[MIT](LICENSE)，欢迎 issue / PR。
- 这是个人自用的插件，接口（`/dsh-video/api/*`）与目录结构可能随版本调整；升级前建议先看 `CONTRACT.md`。
- 与 BibiGPT 的关系：功能灵感来自 BibiGPT 的「链接进去、笔记和问答出来」，实现是独立的，跑在 DeepSeek Harness 上、用你 profile 里已有的模型。
