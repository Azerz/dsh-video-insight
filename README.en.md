# dsh-video-insight · Video Insight

English | [中文](./README.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4d6bfe.svg)](https://github.com/deepseek-ai)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)](#known-limitations)
[![Version](https://img.shields.io/badge/dsh--video--insight-v0.11.1-blue.svg)](package.json)

![dsh-video-insight](icon.svg)

Paste a YouTube or Bilibili link and read the video in your DSH sidebar while you watch it. Summaries, chapters, mind maps, storyboards and timestamped Q&A are generated for you and cached per video. Videos without subtitles are transcribed locally with Whisper; silent videos are read straight from their frames. The model comes from your profile — no extra API key.

There are three fallback tiers: **local Whisper / SenseVoice transcription** (optional engine, threads, first N seconds only) with audio never leaving the machine; **silent screen-only videos** (no speech, no subtitles) fall back to **frame OCR** with macOS Vision, or hand sampled frames to a **vision model** for scene / people / action descriptions ("frame understanding", requires a model that declares image input) — turning picture content into a timestamped transcript while summaries still use the model in your profile.

The moment you paste a link it enters the **background queue**: every video in the home history shows a progress bar, and "Analyze all" enqueues all unfinished history at once (no concurrency cap by default — submit N, run N; set `jobs.concurrency` to a positive number to cap it). The detail page opens as soon as metadata arrives; summary, chapters, mind map and storyboard fill in when the background job finishes, even if you switch tabs or go back home. One job runs the whole chain: summary → mind map → storyboard → (optional) frame descriptions. Job state is in memory; analysis results are still persisted to disk.

Follow-up questions are **RAG (retrieval-augmented)**: the question is first used to BM25-search the transcript, only the most relevant passages (with timestamps) plus the conversation are sent to the model, and the answer cites `[mm:ss]`. Each answer also shows evidence chips that jump back to that moment in the video.

Summary / chapters / mind map / chat are all **cached per video** (`~/.dsh/video-analyses/`). Reopening from History shows the last result immediately; hit "Regenerate" to redo it, or clear a single video's cache.

> Inspired by BibiGPT: link in, notes and Q&A out. The difference is it runs inside DSH, on the model already configured in your profile.

## Entry & layout

The entry sits in the sidebar panel list (`sidebar.panellist`, `order: 30`, after the default entries; adjustable). The icon is a pink play button with a sparkle.

The home page is a single row with the title on the left and actions on the right, followed by a full-width input plus an Analyze button (paste a link and press Enter). "Recently analyzed" is a **four-column card grid** (8 items fit in two rows): cover, duration, title, author, and status badges for summary/chapters/mind map; the `⋯` menu on each card can re-analyze, copy the link, favorite, or delete (the history area scrolls on its own, not the whole page). Once a video is open, a compact input row appears at the top so you can switch links quickly; opening an item from History shows the **cached notes** instead of regenerating them.

There is also a **global job bar**: while any video is being analyzed in the background it shows "Queue 3/8 · Writing summary 42%"; click "Expand" for the job drawer (cancel running, retry failed, open finished, clear all finished). The detail toolbar has two layers: back / cover / title / Regenerate▾ / Export▾ / History / Settings, and a collapsible metadata row (author, duration, published date, stats). Tab labels carry a status dot: solid = done, pulsing = generating, hollow = not generated.

| Tab | What it does |
| --- | --- |
| Summary | Streams automatically after analysis. First screen is card-based: one big one-sentence card plus three small cards (key points / who it's for / memorable quotes), with outline and details folded below. Fixed structure: one-sentence summary / key points / outline / details / memorable quotes / who it's for, with `[mm:ss]` citations — **timestamps in the body are clickable and seek the player**. The model also returns **3 "continue asking" questions** for this video; the host strips them out of the body into `suggestions`, rendered as dashed chips in the ask empty state |
| Chapters | Chapter outline comes from the **first-level mind map nodes** (`GET /outline`; mind map nodes carry time points and act as chapter starts). Falls back to model chapters, native chapters, or pages. Each row has a `GET /thumb` thumbnail; click to jump and keep playing; the current chapter is highlighted during playback |
| Transcript | Segment list (`[mm:ss] text`) with search, per-row copy and copy-all. The "Bilingual" toggle translates every segment (`POST /translate`, batched, cached per video); with "Follow" on, the player highlights and scrolls to the current segment (the player shell reports time every second) |
| Mind map | The transcript is turned into a 3-level tree (`GET /mindmap`, cached) and rendered as an **SVG horizontal tree** (node cards + Bézier links, colored per branch). Click a node to collapse/expand, expand/collapse all, zoom, regenerate. Nodes carry clickable time badges that seek the video |
| Keyframes | Keyframe overview (PPT mode) sharing the same outline as Chapters (`GET /outline`). One click of "Generate descriptions" lets the vision model look at the whole contact sheet and write one line per chapter (`POST /outline/visuals`, a single image is sent); descriptions are cached per video and reused by Chapters. Click a frame to seek there and keep playing |
| Storyboard | Cuts are detected, frames extracted and packed into a **storyboard sheet** (`POST /storyboard`, 3 columns; **frame count and sheet count are derived from duration and cut density**: about one frame per 20 s by default, 24 cells per sheet, overflow goes to a second sheet). Each cell is labeled with its time; click any cell to seek there and keep playing. Optional "describe" lets the vision model describe each cell (hover to see it). Sheets are cached by video in `~/.dsh/video-storyboards/`; the low-res video and cut list are cached in `~/.dsh/video-assets/` and shared by transcription, frame understanding and storyboards |
| Ask | The chat box under the player: multi-turn RAG over the transcript, answers cite `[mm:ss]`, evidence chips jump to the moment; chat is cached per video. Empty state offers three fixed questions plus **3 AI-generated follow-ups** for this video |
| Settings | Bilibili cookie (SESSDATA), stored in `~/.dsh/video-credentials.json` (0600); can be cleared |
| History | Last 100 analyzed/viewed videos (searchable, starrable), stored in `~/.dsh/video-history.json` (survives restarts and browser changes); click to reopen, delete one, or clear all |

The collapsible **embedded player** in the left column points its iframe at the host's `/dsh-video/api/player` shell page — the desktop app runs on the custom `dsh-app://` protocol, where embedding YouTube directly is refused. The shell page is served over http and embeds the real player: YouTube uses the official IFrame Player API (`seekTo` + `playVideo`, so timestamps jump and keep playing), Bilibili uses `player.bilibili.com` (pages and `t` start seconds supported; seeking only reloads the inner iframe). Timestamps in Chapters, Transcript and Mind map seek the player; if collapsed, it expands first. Collapse preference is kept in localStorage. Below 980px the layout stacks into one column.

Errors are always readable Chinese text, never raw stack traces.

## Where data comes from (fallback order)

**YouTube**

1. Fetch the `watch` page and read title, author, duration, views, description, publish date and chapter markers from `ytInitialPlayerResponse`;
2. Subtitles come from the **ANDROID innertube player** (`youtubei/v1/player`, client `ANDROID/20.10.38`) `captionTracks[].baseUrl`, then download `timedtext` (XML `<p t= d=>` or json3 are both supported) — the WEB timedtext endpoint returned an empty body in testing, so ANDROID is **required**;
3. Language preference: Chinese > English, manual tracks over ASR;
4. Without subtitles the UI says so honestly ("no subtitles; the model can only use title/description/chapters").

**Bilibili**

1. `x/web-interface/view` without login for metadata (title, uploader, duration, views/likes/comments/favorites/danmaku, pages, description);
2. Subtitles and the official AI summary need a login cookie (`SESSDATA`): subtitles via the wbi-signed `x/player/wbi/v2` `subtitle.subtitles[].subtitle_url`, official summary via `x/web-interface/view/conclusion/get`;
3. Without a cookie nothing is faked — only a readable warning is shown;
4. The API is concurrency-sensitive (`-352` after a few parallel calls), so the plugin serializes Bilibili requests globally and falls back to `buvid3/buvid4` fingerprints.

**How to fill the cookie**: log in to bilibili.com → DevTools → Application → Cookies → copy `SESSDATA` and paste it in Settings. The plugin builds `SESSDATA=...` and fills in `buvid3` itself.

## No subtitles? Local speech transcription

Some videos (Bilibili UGC, YouTube music, live replays) have no caption track. The panel shows a "no subtitles" note; "Transcribe locally" runs speech recognition on your machine:

1. Download the audio with **yt-dlp** (Bilibili falls back to the official `playurl` URL when yt-dlp is missing);
2. Convert to 16 kHz mono wav with **ffmpeg** (optional `maxSeconds`);
3. Recognize with **whisper.cpp** (default) or **sherpa-onnx SenseVoice**, replacing `doc.transcript` so summary / chapters / ask / transcript all use it;
4. Temporary files are removed (`keepAudio: true` keeps the last audio in `~/.dsh/video-models/last-audio.*`). Transcripts are persisted in `~/.dsh/video-transcripts/<docId>.json`, so an expired resolve cache does not trigger a multi-minute rerun.

**Privacy**: recognition is fully local; audio is never uploaded. Only the resulting text is sent with summary/ask requests to your model. Fully offline summaries would need a local model (this plugin talks to the model service in your profile).

Dependencies (all installable with `brew`; the Settings panel shows which are available):

```bash
brew install ffmpeg yt-dlp whisper.cpp
# Whisper model (default large-v3-turbo q5_0, ~574MB)
mkdir -p ~/.dsh/video-models && cd ~/.dsh/video-models
curl -L -o ggml-large-v3-turbo-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
# Optional: SenseVoice (sherpa-onnx prebuilt release + model)
# https://github.com/k2-fsa/sherpa-onnx/releases  → extract osx-arm64 build into ~/.dsh/video-tools/sherpa-onnx/
# put model.int8.onnx + tokens.txt into ~/.dsh/video-models/sensevoice/
```

Measured on an Apple-silicon Mac: Whisper large-v3-turbo is about **RTF 0.12** (10-minute video ≈ 1.5 minutes); SenseVoice is ~5× faster but has no sentence-level timestamps, so segments are grouped by punctuation.

### No audio either? Frame OCR + frame understanding (vision model)

For silent music videos, muted demos or slide recordings, speech recognition only produces `*music*`. The plugin then falls back to the frames:

1. yt-dlp downloads video up to 480p;
2. **Cut-based frame sampling** (`frameSampling: cuts`, default): scan the picture for edit points, take one frame per shot, then fill up evenly along the timeline; if cut detection fails it falls back to "one frame every `ocrIntervalSeconds`". `cutThreshold` defaults to 27 — higher means only obvious cuts. The scan costs one extra 64×36 decode (~4 s for a 10-minute video), and frames are extracted at exact timestamps;
3. **Local OCR**: macOS Vision recognizes Chinese and English text offline (a small helper is compiled on first use into `~/.dsh/video-tools/ocr/`, 10–20 s, then reused). Nothing leaves the machine;
4. **Frame understanding (optional)**: sampled frames (count derived from duration, ~1 per 20 s, up to 96; 24 frames per sheet) are packed into a **contact sheet** (`visionPack: sheet`, default 3 columns) and sent to an image-capable model, which describes each cell ("cell N = second X") — scene, people/objects, actions and on-screen text. If packing or parsing fails it falls back to per-frame sending (`visionPack: frames`). With `frameMode: auto` this round only runs when OCR yields fewer than ~4 characters per frame (pure animation, vlogs);
5. Results are merged into a timestamped transcript: `source: frame-vision` when described by the vision model, `source: frame-ocr` when only local text was found. Summary, chapters, mind map and ask all work on it.

**Why one sheet**: per-frame sending means 3 requests for 12 frames and 6 for 24, each carrying image tokens. One sheet packs 24 frames into a single request. Measured on the same footage (Big Buck Bunny, 24 frames): input tokens 13,312 → 1,905 (−86%), time 66.0 s → 26.9 s (−59%), with essentially the same coverage; 12 frames showed −73% and −38%.

**Privacy difference**: OCR stays local; frame understanding sends the packed image to the current model (`visionModel` empty = session default; the model must declare `image` input, otherwise the panel lists candidates). Settings can switch to "OCR only" or disable the whole frame fallback.

Quality depends on frame clarity and on-screen text; it is not a substitute for real subtitles. For videos without subtitles this transcription **starts automatically** (the "auto transcribe" toggle in Settings can turn it off); afterwards summary / chapters / ask / transcript switch to the new text.

## Install

Published on npm: [`dsh-video-insight`](https://www.npmjs.com/package/dsh-video-insight).

**① Let the agent install it (easiest)** — in any session say "install the npm package dsh-video-insight", or call the plugin manager tool `plugin_manager`:

```jsonc
{ "action": "install_bundle", "target": "dsh-video-insight" }
```

The installer writes it into the profile's `dependencies` and `dsh.profile.bundles`; a live profile applies immediately — refresh the page and the sidebar entry is there.

**② Install a local clone/folder** — for hacking on the code:

```bash
git clone https://github.com/Azerz/dsh-video-insight.git
```

Then install through the agent, or call `plugin_manager`:

```jsonc
{ "action": "install_bundle", "target": "/path/to/dsh-video-insight" }
```

This writes `"dsh-video-insight": "link:/path/to/dsh-video-insight"` into `dependencies` and appends `"dsh-video-insight"` to `dsh.profile.bundles`.

**③ Manual install** — edit `~/.dsh/profiles/desktop/package.json`:

```jsonc
{
  "dependencies": { "dsh-video-insight": "link:/path/to/dsh-video-insight" },
  "dsh": { "profile": { "bundles": [ /* …, */ "dsh-video-insight" ] } }
}
```

Then run `pnpm install` in that profile directory and restart the app.

Confirm the API is up:

```bash
curl -s http://127.0.0.1:49269/dsh-video/api/status   # port = the actual GUI port
```

The host half has zero external dependencies (only Node built-ins `fetch`/`crypto`), no lockfiles, no build step. Optional dependencies for local transcription / frame analysis: `brew install ffmpeg yt-dlp whisper.cpp` (see above).

### Local components and models (optional)

You only need these for videos without subtitles; if a video has captions, nothing has to be installed.

| Component | Purpose | macOS | Windows |
| --- | --- | --- | --- |
| ffmpeg / ffprobe | frame extraction, wav conversion | `brew install ffmpeg` | `winget install Gyan.FFmpeg` |
| yt-dlp | download audio / low-res video | `brew install yt-dlp` | `winget install yt-dlp.yt-dlp` |
| whisper.cpp (`whisper-cli`) | local Whisper transcription | `brew install whisper.cpp` | download `whisper-bin-x64.zip` from [whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases), unzip, and set the `whisper-cli.exe` path in settings |
| sherpa-onnx | local SenseVoice transcription | download the macOS archive from [sherpa-onnx releases](https://github.com/k2-fsa/sherpa-onnx/releases) and unzip to `~/.dsh/video-tools/sherpa-onnx` | same, Windows archive, same folder |

Models live in `~/.dsh/video-models/` by default (`C:\Users\<you>\.dsh\video-models\` on Windows):

- `ggml-large-v3-turbo-q5_0.bin` (~574 MB, Whisper)
- `sensevoice/model.int8.onnx` + `sensevoice/tokens.txt` (~240 MB, SenseVoice)

Three ways to get ready — pick one:

1. **Click in the panel**: Settings → Local transcription → model card → Download (progress bar, `POST /dsh-video/api/asr/models`).
2. **Download manually**: [Whisper model](https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin) / [SenseVoice model](https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx) + [tokens.txt](https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt), put them in the folder above.
3. **Use another location**: set `whisperModelPath` / `sensevoiceModelPath` / `sensevoiceTokensPath` in settings; binaries can be pointed to with `ffmpegPath` / `ytdlpPath` / `whisperBinaryPath` / `sherpaBinaryPath` (empty = default / PATH lookup).

`GET /dsh-video/api/asr/models` shows whether each file exists and has the expected size.

## Same-origin API (used by the panel; curl-able)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/dsh-video/api/status` | `{ok,value:{version,model,bilibili:{cookie},platforms,transcriptLimitChars,asr:{enabled,ready,engine,activeEngine,engineLabel,downloadReady}}}` |
| GET | `/dsh-video/api/resolve?url=&force=1` | Resolve a link → `VideoDoc` (failures are still HTTP 200 with `{ok:false,code,error}`) |
| GET | `/dsh-video/api/asr/status?fresh=1` | Local-transcription toolchain/engines/models + `ocr` (frame OCR) + `vision` (vision-model capability) + `privacy` text + `hints` |
| POST | `/dsh-video/api/asr/config` | `{enabled?,engine?,threads?,maxSeconds?,keepAudio?,autoTranscribe?,crossCheck?,ocrFallback?,ocrIntervalSeconds?,ocrMaxFrames?,frameSampling?:cuts\|uniform,cutThreshold?,frameMode?:auto\|ocr\|vision,visionModel?,visionMaxFrames?,visionPack?:sheet\|frames,sheetCols?}` → new status |
| POST | `/dsh-video/api/transcribe` | SSE: `{url?/docId?, force?}`; frames `phase` / `progress{percent,stage}` / `done{docId,transcript,cached?}` / `error{code,message}`; falls back to OCR / frame understanding automatically |
| POST | `/dsh-video/api/analyze` | SSE: `{mode:'summary'\|'ask', url?/docId?, question?, history?}`; frames `phase` / `delta` / `done` / `error` |
| POST | `/dsh-video/api/chapters` | `{url?/docId?}` → `{ok,value:{chapters:[{start,title,gist}],duration}}` |
| GET | `/dsh-video/api/storyboard?docId=` | Cached storyboard, or `null` |
| GET | `/dsh-video/api/storyboard/image?docId=&sheet=` | Nth storyboard sheet (`image/jpeg`, `no-store`); `{code:'not-found'}` if never generated |
| POST | `/dsh-video/api/storyboard` | SSE: `{docId?/url?, frames?:0, cols?:3, describe?:boolean, force?:boolean}` (`frames: 0` = auto budget); frames `phase` / `progress{stage:download\|scan\|frames,percent}` / `done{cached,docId,storyboard}` / `error` |
| POST | `/dsh-video/api/storyboard/clear` | `{docId}` delete that video's storyboard (json + jpg) |
| POST | `/dsh-video/api/history/favorite` | `{docId, favorite}` star an item → `{ok,value:{items}}` (survives re-resolve) |
| GET | `/dsh-video/api/outline?docId=` | Outline shared by chapters/keyframes: `{ok,value:{docId,duration,source:'mindmap'\|'chapters'\|'uniform',signature,visuals,items:[{seconds,title,detail,description}]}}` |
| POST | `/dsh-video/api/outline/visuals` | SSE `{docId?/url?, force}`: sample frames → one sheet → vision descriptions; frames `phase`/`progress`/`done{items,cached,usage}`/`error` |
| POST | `/dsh-video/api/outline/clear` | `{docId}` drop cached frame descriptions |
| GET | `/dsh-video/api/keyframes?docId=&count=16` | Keyframe timestamps (same source as `/outline`, kept for older clients) |
| GET | `/dsh-video/api/thumb?docId=&seconds=&w=320` | Frame thumbnail at a time point (`image/jpeg`; cut from the cached low-res video); also accepts `url=` instead of `docId=` |
| GET | `/dsh-video/api/assets?docId=` | Asset-cache status, or `null` |
| POST | `/dsh-video/api/assets/clear` | `{docId}` drop the low-res video and cut cache |
| GET | `/dsh-video/api/translate?docId=&lang=zh\|en` | Cached bilingual pairs, or `null` |
| POST | `/dsh-video/api/translate` | SSE `{docId?/url?, lang:'zh'\|'en', force?}`; batches of 40 segments / 3200 chars, cached in `~/.dsh/video-translations/` |
| POST | `/dsh-video/api/translate/clear` | `{docId, lang}` drop one language's translation |
| GET | `/dsh-video/api/mindmap?docId=&force=1` | Transcript → `{ok,value:{docId,mindmap:{title,children[]},source:'llm'\|'cache',generatedAt,cached}}`; `no-transcript` without text; result is written to the analysis cache |
| GET | `/dsh-video/api/player?platform=&id=&page=&start=` | Player shell HTML so YouTube plays under the desktop custom protocol |
| POST | `/dsh-video/api/credentials` | `{bilibiliCookie}`; empty string clears |
| POST | `/dsh-video/api/credentials/clear` | Clear credentials |
| GET | `/dsh-video/api/analysis?docId=` | Analysis cache for one video |
| POST | `/dsh-video/api/analysis/clear` | `{docId}` clear all analysis (summary/chapters/mind map/chat) |
| POST | `/dsh-video/api/analysis/chat/clear` | `{docId}` clear only the chat |
| POST | `/dsh-video/api/jobs` | Start a background job: `{docId?/url?, describe?:true}` → `{ok,value:{job,created}}` (no duplicate for the same video) |
| GET | `/dsh-video/api/jobs` | Queue snapshot: `{ok,value:{concurrency,active,running,jobs:[…]}}` (polled by the progress bar) |
| POST | `/dsh-video/api/jobs/all` | Enqueue unfinished history: `{limit?:20, force?:false, describe?:true}` |
| POST | `/dsh-video/api/jobs/cancel` | `{id}` or `{docId}` |
| POST | `/dsh-video/api/jobs/clear` | Clear finished job records |
| GET | `/dsh-video/api/history` | Last 100 items, newest first, with `hasSummary/hasChapters/hasMindmap/chatCount` |
| POST | `/dsh-video/api/history/remove` | `{docId}` delete one |
| POST | `/dsh-video/api/history/clear` | Clear history |

`POST /analyze` with `mode=ask` returns `citations: [{start,end,preview,score}]` in the `done` frame, and `GET /resolve` may include an `analysis` field. VideoDoc fields and full shapes are documented in [CONTRACT.md](./CONTRACT.md).

## Tools for agents

The plugin registers **two global tools** (`ctx.tools.register`, not agent-scoped), so any session — including QQ sessions created by qqbot via `ctx.agents.create()` — can call them without extra setup:

| Tool | Purpose |
| --- | --- |
| `video_digest` | Preferred in chat: `url` (required) + optional `question`; returns a plain-text digest (title, author, duration, link, subtitle source, six-section summary, or the answer). `maxChars` defaults to 1800 |
| `video` | For details: `action=resolve` (metadata + transcript with `[mm:ss]`), `transcribe` (local speech/OCR fallback), `summary`, `ask` (RAG follow-up, with evidence timestamps) |

Both tools share the Bilibili cookie with the panel. **Videos analyzed through the tools are also written to History and the analysis cache** (recorded as view/analyze), so they show up in "Recently analyzed" and are reused. `url` accepts full links, `youtu.be`/`b23.tv` short links and bare `BV` ids.

## Configuration

In `cordis.patch.yml`:

```yaml
- insert:
    - id: video
      name: 'dsh-video-insight'
      config:
        bilibiliCookie: ''      # or (recommended) fill it in the panel's Settings
        transcriptLimitChars: 60000
        requestTimeoutMs: 20000
        asr:
          enabled: true
          engine: auto          # auto | whisper | sensevoice
          autoTranscribe: true  # auto-transcribe videos without subtitles
          crossCheck: true      # run speech + frames in parallel and cross-check (default true)
          ocrFallback: true       # when there is no speech, extract frames and OCR them
          frameSampling: cuts     # cuts = by shot boundaries (default) | uniform
          cutThreshold: 27        # cut threshold (6-40), higher = obvious cuts only
          ocrIntervalSeconds: 8   # interval for the uniform fallback
          ocrMaxFrames: 120       # max frames to OCR
          frameMode: auto         # auto | ocr | vision
          visionModel: ''         # provider/model, empty = session default
          visionMaxFrames: 48     # max frames for frame understanding
          visionPack: sheet       # sheet = one contact sheet (default) | frames
          sheetCols: 3            # columns per sheet (rows auto)
        jobs:
          concurrency: 0          # background jobs: 0 = unlimited (default), >0 caps at 16
```

The cookie and local-transcription settings saved from the panel go to `~/.dsh/video-credentials.json` and **take precedence** over the row config; changes apply immediately.

## Languages

- **UI follows DSH**: by default it follows the DSH locale — Chinese UI gets Chinese, anything else gets English (DSH locales such as `ja/es/fr/de/ru/pt` are also passed to the AI as the output language).
- **Override in Settings**: Settings → Language, choose "Follow DSH / 中文 / English"; the change applies immediately (stored locally as `dsh-video.lang`).
- **AI output in that language**: summaries, follow-ups, chapters, mind map and frame descriptions are generated in the current language; Chinese and English have full templates and section headings, other languages use the English template plus an explicit target-language instruction.
- **Caches are per language**: a Chinese summary and an English summary of the same video are cached separately, so switching languages never shows stale content in the other language.

## Known limitations

- Resolve cache: 30 minutes (LRU 24); `force=1` refreshes it (analysis cache is unaffected — kept per video forever).
- RAG is keyword retrieval (BM25 + Traditional→Simplified normalization), no vector search; very abstract questions or unusual wording may miss all passages — then it says plainly "the video doesn't mention this".
- The analysis cache does not store transcripts: platform subtitles are re-fetched by `/resolve`, local transcripts live in `~/.dsh/video-transcripts/`.
- YouTube subtitles are timed text; punctuation/filler words can be noisy. Rolling-caption duplicate windows are de-duplicated.
- Bilibili subtitles require a cookie **and** the video actually having AI subtitles.
- With cut-based sampling, the end time of a frame-OCR segment is estimated from neighboring frame gaps (each frame's own second is exact).
- Speech transcription and frame analysis run **in parallel**: `crossCheck` is on by default — `POST /transcribe` starts downloading both audio and low-res video immediately, runs Whisper and frame recognition at the same time, and merges both into one transcript (frame lines prefixed with "画面："). Set `crossCheck: false` for the old sequential path.
- Frame OCR: macOS only (system Vision framework); quality depends on legible text; scrolling danmaku and fancy fonts fail; sampling follows shot cuts (uniform when none), so coverage depends on shot count rather than a fixed interval.
- Frame count is computed from duration + cut density by `lib/budget.js` (see the table in the Chinese README): about 1 frame / 20 s (12 s for fast cuts, 30 s for long takes), min 6, max `visionMaxFrames` (default 96, up to 240), 24 cells per sheet, overflow to a second sheet.
- Frame understanding needs a model declaring `image` input; the sheet is sent to that model (unlike local OCR). Billing is per sheet (~9–24 cells), generation takes 15–30 s; a video with neither text nor describable content still ends with `asr-empty`.
- Local transcription: Whisper spends 6–12 s loading the 574 MB model per call (negligible for long videos); SenseVoice timestamps are punctuation-based approximations; `threads: 0` lets the engine decide.
- Bilingual translation calls the current model in batches (40 segments / 3200 chars); long videos need a dozen batches. "Follow playback" relies on the player shell reporting time — only the YouTube player does; the Bilibili player has no progress reporting (no error, no highlight).
- Storyboard: max 2 sheets / 48 cells; the first run downloads 480p and scans cuts (10–20 s for a 10-minute video); the video and cut list are cached in `~/.dsh/video-assets/` (max 8 videos / 2 GB / 30 days) and reused, so regeneration takes ~1 s; "describe" sends frames to the vision model.
- Only single links — no playlists or collections.

## Development

```bash
node test/client.test.mjs   # panel client self-test (no third-party deps; fake DOM/fetch/SSE)
```

## Open source

- Repo: [github.com/Azerz/dsh-video-insight](https://github.com/Azerz/dsh-video-insight)
- License: [MIT](LICENSE); issues and PRs welcome.
- A personal plugin: the `/dsh-video/api/*` surface and folder layout may change between releases — read `CONTRACT.md` before upgrading.
- Relationship to BibiGPT: the idea ("link in, notes and Q&A out") is inspired by BibiGPT; this implementation is independent, runs on DeepSeek Harness and uses the model already in your profile.
