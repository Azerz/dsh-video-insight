# dsh-video-insight 发布前 QA 报告

> 被测代码：**`66b61f9`**（HEAD，2026-11-18 03:05:33 +0800）。检查开始时（03:10）工作树干净、`origin/main` 与本地 0/0 同步；检查结束前（03:21）工作区出现未提交的 0.9.0 开发变更，见 Q1-4，发布 0.8.0 必须用干净树/ tag worktree。
> 注意：**Git tag `v0.8.0` 指向的是 `eb0d2e6`**（02:55:46），比 HEAD 落后 2 个 README 文档提交（`31541fd`、`66b61f9`，只改了 README 首段两行，不影响代码/测试/版本号），见 Q1-3。
> 检查时间：2026-11-18 03:00–03:21 +0800。检查方式：**只读**（`npm pack --dry-run`、只读 git 命令、curl 打现有宿主 `http://127.0.0.1:49269/dsh-video/api`）。未改动任何源码，未执行 `npm publish` / `git commit` / `git push`。
> 宿主实际加载版本：**0.7.0**（`GET /status`）——0.8.0 代码尚未在运行态宿主里跑过，见 Q1-2。

## TL;DR

- **打包、仓库卫生、客户端测试、接口形状**：✅ 通过，没有会阻断 npm 发布的硬伤。
- **发布阻塞在流程而非代码**：npm 上 latest 仍是 `0.4.8`（0.8.0 未发布），市场索引也还是 `0.4.8`；另外检查结束时工作区混入了进行中的 0.9.0 改动（Q1-4），**不能直接从当前工作区发布**。
- **发布前必须处理 5 件事**（详见「问题清单」）：
  1. 用 `git worktree add /tmp/vi-rel v0.8.0`（或 clean HEAD）的干净树发布，隔离工作区里未提交的 0.9.0 变更（Q1-4，负责人 lead）；
  2. 重启 App / 重载插件，让 `/status` 变成 `0.8.0` 后再做运行态冒烟（Q1-2，负责人 lead）；
  3. 把 tag `v0.8.0` 与 HEAD（`66b61f9`）对齐，或从 `v0.8.0` 的树发布（Q1-3，负责人 lead）；
  4. 修 `readBody` 请求体上限失效（Q2-1，负责人 lead，改 5 个实参即可）；
  5. 文档小修：`CONTRACT.md` 版本示例、`README.md:184`「最近 20 条」、`CONTRACT.md` 相对链接（Q2-2/Q2-3/Q3-3）。

## 1. 打包与元数据（`npm pack --dry-run --json`）

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
| `npm pack --dry-run` 可正常产出 | ✅ | `id dsh-video-insight@0.8.0`，tarball `dsh-video-insight-0.8.0.tgz`，size 186,319 B，unpacked 617,744 B，**32 个文件**（`eb0d2e6` 快照为 186,323 / 617,711，差异只来自 README 首段） |
| `files` 覆盖 `lib/` | ✅ | `"lib/*.js"`，24 个 `lib/*.js` 全部进包 |
| `files` 覆盖 `client/` | ✅ | `"client/*.js"` → `client/client.js`（单文件客户端） |
| `files` 覆盖 `locale/` | ✅ | `"locale/*.json"` → `locale/en.json`、`locale/zh.json` |
| `cordis.patch.yml` 进包 | ✅ | 白名单显式列出 |
| `icon.svg` 进包 | ✅ | 白名单显式列出；`icon.svg` 815 B，`file` 判定有效 SVG，远低于 256 KiB 上限 |
| `README.md` 进包 | ✅ | 白名单显式列出（插件详情页回落到它） |
| `LICENSE` | ✅ | 不在 `files` 里，但 npm 自动包含（`MIT`） |
| `CONTRACT.md` 是否该发 | ⚠️ 见 Q2-2 | 当前**没发**；但 README 有 3 处相对链接指向它 |
| `test/`、`docs/` 不进包 | ✅ | 合理（自测/内部文档不发布） |
| `CHANGELOG.md` 不进包 | ⚠️ 可接受 | npm 页面不会渲染更新日志；想展示需手动加进 `files`（可选，非阻塞） |
| 包自包含性（无传染依赖） | ✅ | `lib/` 里**没有**任何非相对、非 `node:` 的 import；实测解包后 `HOME=/tmp/fake` 直接 `import lib/index.js` 成功，导出 `API_PREFIX, VideoError, apply, buildDigestText, createResolver, name` |
| 客户端语法 | ✅ | `node --check client/client.js` 通过 |

### package.json 字段

| 字段 | 现状 | 结果 |
| --- | --- | --- |
| `name` / `version` | `dsh-video-insight` / `0.8.0` | ✅ |
| `private` | 已删除 | ✅（对照 `dsh-zhihu` 的 `"private": true`，本插件正确没有） |
| `license` | `MIT` | ✅ |
| `author` | `Jerry (Azerz)` | ✅ |
| `repository` | `git+https://github.com/Azerz/dsh-video-insight.git` | ✅ |
| `homepage` | `https://github.com/Azerz/dsh-video-insight#readme` | ✅ |
| `bugs` | `https://github.com/Azerz/dsh-video-insight/issues` | ✅ |
| `keywords` | 15 个 | ✅ |
| `dsh.bundle.patch` | `./cordis.patch.yml` | ✅ 与 `dsh-doc/references/ui-plugin.md`、`host-plugin.md` 一致 |
| `dsh.client.platform` | `web` | ✅（与可用的 `dsh-zhihu` 声明同形） |
| `exports` | `.` / `./client` / `./locale/*.json` / `./icon` / `./package.json` | ✅ |
| `main` | `lib/index.js` | ✅ |
| `type` | `module` | ✅ |
| **`engines.node`** | **缺失** | ❌ Q3-1（registry / 市场索引里 `engines: {}`） |
| `scripts` | 缺失 | ⚠️ Q3-2：没有 `test` / `prepublishOnly`，自测只能手跑 |
| 外部依赖 | 零（`dependencies`/`devDependencies` 均无） | ✅ 与 README「host 半零外部依赖、不跑构建」一致 |

## 2. 版本一致性

| 位置 | 值 | 结果 |
| --- | --- | --- |
| `package.json:3` | `"version": "0.8.0"` | ✅ |
| `lib/index.js:62` | `const VERSION = '0.8.0';` | ✅ |
| `README.md:6` 徽章 | `dsh--video--insight-v0.8.0` | ✅ |
| `CHANGELOG.md` 顶部 | `## v0.8.0（2026-11-18）` | ✅ |
| `cordis.patch.yml` | 不含版本号 | N/A（不参与一致性） |
| `CONTRACT.md:16` | `"version": "0.4.4",` | ❌ 陈旧示例，Q2-2 |
| 提交与 tag | HEAD `66b61f9`，`origin/main` 已同步（0/0） | ✅ |
| Git tag | `v0.4.8`、`v0.8.0`；`v0.8.0` → `eb0d2e6`，本地与 `origin` 一致，但**落后 HEAD 2 个 README 提交** | ⚠️ Q1-3 |
| 运行态宿主 `/status` | `0.7.0` | ❌ 未重启，Q1-2 |

## 3. 仓库卫生

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
| 追踪文件数 | ✅ 37 个，全部为源码/文档/测试 | `git ls-files` |
| 误提交凭证 | ✅ 无 | 没有 `.video-credentials.json` / `video-credentials.json` / `video-history.json` |
| 误提交测试产物 | ✅ 无 | 没有 `video-history/`、`video-analyses/`、`video-transcripts/`、`video-storyboards/`、`video-assets/` 的副本 |
| `.DS_Store` / `*.tgz` 被追踪 | ✅ 无 | `.gitignore` 已覆盖 `.DS_Store`、`*.log`、`*.tgz`、凭证与历史文件名 |
| 大文件 | ✅ 无 | 最大的追踪文件都在几百 KB 级别，无图片/视频二进制 |
| 未追踪残留 | ⚠️ 建议清理 | 磁盘上有被 gitignore 的 `.DS_Store` 与陈旧 `dsh-video-insight.tgz`（146,592 B，0.4.8 时代），不进包但容易误发/误上传 |
| `.github/`（CI） | 无 | 本项目不跑 CI，发布前所有检查靠手工（见发布手册） |

## 4. 测试与构建

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
| 客户端自测 | ✅ | `node test/client.test.mjs` → `pass 282/282（282 项全部通过）` |
| 测试无第三方依赖 | ✅ | 脚本自带 fake DOM / React / fetch / SSE |
| host 半构建 | ✅ 无需构建 | 纯 ESM，零依赖，直接跑源码 |
| 面板客户端语法 | ✅ | `node --check client/client.js` |
| 面板 7 个页签存在 | ✅ | `client/client.js:73` TABS 含 `summary/chapters/transcript/bookmarks/storyboard/keyframes/mindmap`，README `关键画面` 行与实现一致 |

## 5. 接口冒烟（打 live 0.7.0 宿主，测试 docId `youtube:dQw4w9WgXcQ`）

| 接口 | HTTP | Content-Type | 关键字段 / 结果 | 判定 |
| --- | --- | --- | --- | --- |
| `GET /status` | 200 | json | `version:"0.7.0"`、`model{provider,model}`、`bilibili{cookie:true}`、`platforms{youtube:true,bilibili:true}`、`transcriptLimitChars:60000`、`asr{enabled:true,ready:true,engine:"auto",activeEngine:"whisper",engineLabel,downloadReady:true}` | ✅ 形状与 README 表一致 |
| `GET /history` | 200 | json | 10 KB；items 含 `docId/url/platform/id/title/author/duration/cover/hasTranscript/favorite/analyzedAt/action/hasSummary/hasChapters/hasMindmap/chatCount` | ✅ |
| `GET /bookmarks?docId=…` | 200 | json | `{docId,url:"",title:"",updatedAt:0,items:[]}`（空态） | ✅ 空态形状正确 |
| `GET /assets?docId=…` | 200 | json | `{video:{bytes,duration,downloadedAt},cuts:{count,threshold,createdAt}}` | ✅ |
| `GET /storyboard?docId=…` | 200 | json | `docId/url/title/platform/duration/generatedAt/tookMs/frameSampling:"cuts"/cuts:56/frames:8/cols:3/rows:3/cellWidth:512/cellHeight:288/described:false/cells[{index,row,col,seconds}]` | ✅ |
| `GET /storyboard/image?docId=…` | 200 | `image/jpeg` | 90,523 B，1536×864，`cache-control: no-store` | ✅ |
| `GET /thumb?docId=…&seconds=60` | 200 | `image/jpeg` | 4,662 B，实际 320×180；`cache-control: private,max-age=86400`、`x-content-type-options: nosniff` | ✅ |
| `GET /thumb`（无参数） | 404 | json | `{ok:false,code:"not-found",error:"没有这个视频的缓存，请先解析一次（或传 url=）。"}` | ✅ |
| `GET /keyframes?docId=…&count=16` | 200 | json | 9 条（章节起点），`{seconds,label}` | ✅ 与 README 表一致 |
| `GET /mindmap?docId=…` | 200 | json | 树形 mindmap（节点带时间点） | ✅ |
| `GET /asr/status` | 200 | json | 含 `ocr{available:true,label:"画面文字（macOS Vision）",binaryPath,platform:"darwin"}`、`vision`、`privacy`、`hints` | ✅ |
| `GET /player?platform=youtube&id=dQw4w9WgXcQ&start=60` | 200 | `text/html` | 4,577 B 播放器外壳 | ✅ |
| `GET /player?platform=bilibili&id=BV1bMJX6jEvR&page=1&start=30` | 200 | `text/html` | 4,584 B | ✅ |
| `GET /player`（参数不合法） | 400 | `text/html` | `播放器参数不合法。`（按 `parsePlayerQuery` 设计） | ✅ 有意为之 |
| 未知路由 | 404 | json | `{ok:false,code:"not-found",error:"未知接口 /nope"}` | ✅ |
| `POST /analyze`（`{}`） | 200 | SSE | `: dsh-video stream` → phase「正在解析视频信息…」→ `{"type":"error","code":"bad-url",…}`，**未花模型 token** | ✅ |
| `POST /analyze`（非法 JSON） | 200 | json | `{ok:false,code:"bad-json",error:"请求体不是合法 JSON"}` | ✅（所有路由错误统一 200 + `ok:false`，CONTRACT 已声明） |
| `POST /bookmarks/add`（缺参数） | 200 | json | `{ok:false,code:"bad-param",error:"缺少 docId 或 url。"}` | ✅ |
| `POST /history/favorite`（缺参数） | 200 | json | `{ok:false,code:"bad-param",error:"缺少 docId。"}` | ✅ |
| `GET /assets`（未知 doc） | 200 | json | `{ok:true,value:null}` | ✅ |
| `GET /bookmarks`（未知 doc） | 200 | json | 空结构（同上 bookmarks 空态） | ✅ |

> 实现共 32 个路径（31 个 `route ===` 字面量 + `/player` 经 `PLAYER_PATH` 注册）；README API 表覆盖 31 个，唯一没写的是调试用的 `POST /vision-bench`（`lib/index.js:1232`）。见 Q3-6。

## 6. README / 安装路径复核

| 检查项 | 结果 | 说明 |
| --- | --- | --- |
| ① npm 安装：`plugin_manager {"action":"install_bundle","target":"dsh-video-insight"}` | ✅ 语义正确 | `plugin_manager` 文档允许 target 为「包名 / spec」；但**当前会装到 0.4.8**（npm latest 还是旧的），发布 0.8.0 后才兑现 |
| ② 本地目录安装：`target: "/path/to/dsh-video-insight"` | ✅ 语义正确 | 与 profile 现状一致：`~/.dsh/profiles/desktop/package.json` 里是 `"dsh-video-insight": "link:/Users/zhujianyu/Desktop/Dsh-plugins/dsh-video-insight"`，`node_modules` 里是 symlink |
| ③ 手工改 profile `package.json` + `pnpm install` + 重启 | ⚠️ 可用 | dsh 官方文档（`dsh-doc/references/plugin-development.md`）不建议手写 profile，作为兜底可接受；用前建议先试 ①② |
| README:107「已经发布到 npm」 | ⚠️ 部分成立 | 包在 npm 上存在，但 latest 是 0.4.8（`created 2026-11-12T11:22:57Z`，maintainer `azerz`） |
| README:145 示例端口 `50231` | ⚠️ 过期 | 实际宿主是 `49269`；行尾注释写了「端口以实际 GUI 为准」，影响不大 |
| README:188/190/258 相对链接 `[CONTRACT.md](./CONTRACT.md)` | ⚠️ npm 页面 404 | `CONTRACT.md` 不在 `files`；插件详情页按规则把相对链接渲染成纯文本，影响有限 |
| README API 表与实现 | ✅ 基本一致 | 33 行覆盖 31 个路径（见第 5 节末尾 caveat） |
| README「已知限制」 | ✅ 与实现一致 | OCR 仅 macOS（与 `/asr/status` 的 `ocr.platform:"darwin"` 对齐）、本地转写、画面理解出网等都写明了 |
| README「开发与自测」 | ✅ | `node test/client.test.mjs` 可跑，282/282 |

## 7. 问题清单（按严重度）

### P1 — 发布流程（不是代码缺陷）

**Q1-1 npm 上 0.8.0 不存在，latest 仍 0.4.8**
- 证据：`npm view dsh-video-insight version` → `0.4.8`；registry `versions` 只有 `["0.4.8"]`；市场索引 `dsh-plugin-catalog` 里 `versions[0].version = "0.4.8"`。
- 影响：README 的安装路径 ① 现在装到的是 0.4.8（没有关键画面/历史搜索等）；市场详情页也停在 0.4.8。
- 建议：按 `docs/RELEASE.md` 执行 `npm publish`，然后等索引同步。
- 建议修复人：**lead**。

**Q1-2 运行态宿主还是 0.7.0，0.8.0 未在真实宿主验证**
- 证据：`curl -s http://127.0.0.1:49269/dsh-video/api/status` → `"version":"0.7.0"`；本仓库 `package.json` 已是 `0.8.0`。宿主模块在启动时加载，改仓库文件不会热替换 host 半。
- 影响：`/keyframes`、历史收藏等是 0.7.0 的 host 代码在跑，0.8.0 的 host 侧（含历史搜索相关字段）没有运行态证据；「关键画面」页签的浏览器侧也需刷新页面/重启后才加载新版 `client.js`。
- 建议：重启 DeepSeek Harness（或重新激活该 bundle），确认 `/status` 返回 `0.8.0`，再刷新页面看 7 个页签。
- 建议修复人：**lead**。

**Q1-3 tag `v0.8.0` 落后 HEAD 2 个提交（tag 的树与将要发布的包不一致）**
- 证据：`git tag v0.8.0` → `eb0d2e6`（02:55:46）；HEAD = `66b61f9`（03:05:33）；`git rev-list --oneline v0.8.0..HEAD` → `31541fd docs: README 首段改三句话总结亮点`、`66b61f9 docs: 去掉首段与第二段的重复表述`；`git diff --stat v0.8.0..HEAD` → `README.md | 4 ++--`。
- 影响：README 在 npm 包的 `files` 白名单里，所以「从 HEAD 打包」与「从 tag 打包」出来的 tarball README 不同；GitHub Release 页面（跟 tag）与 npm 包内容会对不上。代码、版本号、测试均不受影响（测试在 HEAD 仍 282/282）。
- 建议（发布前二选一）：
  - ① 更省事：发布前把 tag 移到 HEAD —— `git tag -f v0.8.0 HEAD && git push -f origin v0.8.0`（**只在 npm / GitHub Release 落地前做**；一旦发布过就不要再移动 tag，改发 0.8.1）；
  - ② 更保守：不动 tag，从 tag 的树发布 —— `git worktree add /tmp/vi-rel v0.8.0`，在 `/tmp/vi-rel` 里执行打包/publish，README 首段这些文档改动随 0.8.1 发。
- 建议修复人：**lead**。

**Q1-4 检查结束前工作区出现未提交的 0.9.0 开发变更（发布 0.8.0 前必须隔离）**
- 证据（2026-11-18 03:21 +0800 实测 `git status --short`）：
  - ` D lib/bookmarks.js`、` M lib/index.js`、` M package.json`、`?? lib/outline.js`
  - `git diff package.json` → `"version": "0.9.0"`；在工作区跑 `npm pack --dry-run` → **`dsh-video-insight@0.9.0`**，32 文件，文件集变成「含 `lib/outline.js`、不含 `lib/bookmarks.js`」。
- 影响：**不能**在当前工作区直接 `npm pack` / `npm publish`，否则会把进行中的 0.9.0（大纲重构、bookmarks 合并进 index）当成 0.8.0 发出去，且与 tag `v0.8.0` / HEAD `66b61f9` 都对不上。本 QA 的打包数字（186,319 B / 617,744 B / 32 文件）是 **HEAD `66b61f9` 干净树**的结果，不是当前脏树；脏树打出来的 0.8.0 发布物会不一样。
- 建议：发布 0.8.0 一律用 `git worktree add /tmp/vi-rel v0.8.0` 出来的干净树（`docs/RELEASE.md` 步骤 0.5 ②，或先 `git stash`/等 0.9.0 提交后从独立 worktree 发布）；0.9.0 的变更等提交、测试、升版本后另走一次发布。
- 建议修复人：**lead**（发布执行者）；正在改 `lib/index.js` 的 **video-ui** 提交前先与 lead 对齐发布顺序。

### P2 — 代码 / 契约文档

**Q2-1 `readBody` 请求体上限失效（5 处实参类型错误）**
- 位置：`lib/index.js:153` 定义 `function readBody(req, limitBytes = MAX_ANALYZE_BODY)`（第二参是**数字**）；但调用处传了对象：
  - `lib/index.js:725`、`1011`、`1061`、`1073` → `readBody(req, { limit: 64 * 1024 })`
  - `lib/index.js:1034` → `readBody(req, { limit: 256 * 1024 })`
- 原因：`if (size > limitBytes)` 里 `limitBytes` 是对象 → 比较结果为 `false`，上限形同虚设。
- 实测证据（live 宿主，请求体全部被完整读取并 JSON 解析）：
  - `POST /bookmarks/add` 发 **300 KB**（声称上限 256 KB）→ `200 {"ok":false,"code":"bad-param","error":"缺少 docId 或 url。"}`
  - `POST /history/favorite` 发 **1 MB**（声称上限 64 KB）→ `200 {"ok":false,"code":"bad-param","error":"缺少 docId。"}`
- 影响：同源本机 API，攻击面小，但这是个「本应生效却没生效」的保护；大请求体可以无上限地占内存。
- 建议：把 5 处改成 `readBody(req, 64 * 1024)` / `readBody(req, 256 * 1024)`；或把签名改成 `readBody(req, { limit = MAX_ANALYZE_BODY } = {})` 并同步所有调用（当前还有 `readBody(req)` 的调用，两者要统一）。
- 建议修复人：**lead**（host 半）。

**Q2-2 `CONTRACT.md`：未随包发布 + 版本示例陈旧**
- 位置：`package.json` 的 `files` 不含 `CONTRACT.md`；但 `README.md:188`、`190`、`258` 都链接 `./CONTRACT.md` → 在 npmjs.com 的包页面上相对链接会 404（插件详情页按规则把相对链接渲染为纯文本，影响有限）。
- 另外 `CONTRACT.md:16` 的 `/status` 示例仍是 `"version": "0.4.4"`，落后 4 个版本。
- 建议（二选一）：① 把 `CONTRACT.md` 加进 `files`（文件不大，约 10 KB 级）；② 把 README 里的 `[CONTRACT.md](./CONTRACT.md)` 改成不带链接的「仓库里的 `CONTRACT.md`」。同时把 `CONTRACT.md:16` 更新为 `"version": "0.8.0"`。
- 建议修复人：**lead**。

**Q2-3 README 内部不一致：历史条数**
- 位置：`README.md:37` 写「最近 **100** 条」，`README.md:184` 的 API 表仍写「最近 **20** 条」。
- 证据：`lib/history.js` 与 CHANGELOG v0.8.0 都是 100 条。
- 建议：`README.md:184` 改成 100 条。
- 建议修复人：**video-ui**。

### P3 — 卫生 / 小瑕疵（不阻塞发布）

| ID | 位置 | 问题 | 建议修复人 |
| --- | --- | --- | --- |
| Q3-1 | `package.json` | 缺 `engines.node`（registry 与市场索引里 `engines: {}`）；插件实际需要 Node 18+（用 `node:` 内置模块 + 全局 `fetch`）。建议加 `"engines": { "node": ">=18" }` | lead |
| Q3-2 | `package.json` | 无 `scripts`：没有 `test` / `prepublishOnly`。建议加 `"scripts": { "test": "node test/client.test.mjs" }`，发布前 `npm test` | lead |
| Q3-3 | 包内文件权限 | `npm pack` 出来的 32 个文件里 **29 个是 0600**（含 `package.json`），只有 `LICENSE`、`lib/define-tool.js`、`lib/zh.js` 是 0644。git 索引里都是 100644，所以**从干净 clone 打包不会有这个问题**；当前工作区是 umask 造成的。发布前可 `chmod -R u+rwX,go+rX lib client locale icon.svg cordis.patch.yml README.md package.json LICENSE CONTRACT.md CHANGELOG.md`（只改权限位） | lead |
| Q3-4 | `README.md:145` | curl 示例端口 `50231` 与实际 `49269` 不符（行尾已注明以实际 GUI 为准） | video-ui |
| Q3-5 | `CHANGELOG.md` | v0.8.0 与 v0.7.0 都写了「历史上限 100 / 收藏 / keyframes」，条目重复 | video-ui |
| Q3-6 | `lib/index.js:1232` | 调试接口 `POST /vision-bench` 没写进 README API 表（内部实验接口，可选择不文档化或标注） | video-ui（文档） |
| Q3-7 | README 顶部 Platform 徽章 | 徽章写 `macOS | Linux | Windows`，而 OCR 兜底只有 macOS；「已知限制」里已说明，可接受，但可在徽章旁点一句 | video-ui |
| Q3-8 | 市场入口描述（仓库外） | `awesome-dsh-plugin` 里 `data/plugins/Azerz__dsh-video-insight.yml` 的描述还写着「20-item history」，也没提关键画面/分镜/片段。发布后可用一个 PR 更新（描述由该 yml 生成 README，版本号由 npm 自动带） | lead |

## 8. 未覆盖 / 无法验证项

1. **写路径成功分支未实测**：一次「写入测试收藏」的 shell 调用被本会话 auto-review 拒绝（不是命令失败，未重试），因此 `POST /bookmarks/add|remove|clear`、`POST /history/favorite` 的**成功分支**和 bookmarks 条目 schema（`{id,start,end,text,label,createdAt}`）没有运行态证据；只验证了参数校验分支与请求体上限行为。
2. **真实分析/转写**：`POST /analyze`、`POST /transcribe`、`POST /translate` 的成功路径要花模型 token / CPU（Whisper 574 MB 模型），未跑；只验证了 SSE 错误帧与参数校验。
3. **浏览器 UI 交互**：没有浏览器控制能力，7 个页签的真实渲染 / 点击跳转未逐项点过（客户端逻辑由 282 项自测覆盖）。
4. **npm publish 预演**：按约束没有执行 `npm publish`（含 `--dry-run`），发布动作留给 lead，步骤见 `docs/RELEASE.md`。
5. **0.8.0 host 运行态**：见 Q1-2，需重启后复测。

## 9. 复现命令

```bash
cd /Users/zhujianyu/Desktop/Dsh-plugins/dsh-video-insight

# 版本一致性
node -p "require('./package.json').version"
grep -n "const VERSION" lib/index.js
grep -n "img.shields.io/badge/dsh--video--insight" README.md

# tag 与 HEAD 对齐（两条期望都为空；当前实测非空 → Q1-3）
git rev-list --oneline v0.8.0..HEAD
git diff --stat v0.8.0..HEAD

# 打包清单（不写磁盘）
npm pack --dry-run --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=JSON.parse(s)[Object.keys(JSON.parse(s))[0]];console.log(p.id,p.size,p.unpackedSize,p.entryCount);console.log(p.files.map(f=>f.path).join('\n'))})"

# 包自包含性（解包后直接 import，不经过宿主）
rm -rf /tmp/qa-pack && mkdir -p /tmp/qa-pack/pkg /tmp/qa-pack/home
npm pack --pack-destination /tmp/qa-pack
tar -xzf /tmp/qa-pack/dsh-video-insight-0.8.0.tgz -C /tmp/qa-pack/pkg
HOME=/tmp/qa-pack/home node --input-type=module -e "const m=await import('/tmp/qa-pack/pkg/package/lib/index.js');console.log(Object.keys(m))"
node --check /tmp/qa-pack/pkg/package/client/client.js

# 客户端测试
node test/client.test.mjs

# 宿主冒烟（注意：当前宿主仍加载 0.7.0，重启后应返回 0.8.0 —— 见 Q1-2）
curl -s http://127.0.0.1:49269/dsh-video/api/status
curl -s "http://127.0.0.1:49269/dsh-video/api/keyframes?docId=youtube:dQw4w9WgXcQ&count=16"
curl -s -o /dev/null -w '%{http_code} %{content_type} %{size_download}\n' \
  "http://127.0.0.1:49269/dsh-video/api/thumb?docId=youtube:dQw4w9WgXcQ&seconds=60"

# 仓库卫生
git ls-files | wc -l && git status --short
git tag -l && git ls-remote --tags origin

# 外部状态
npm view dsh-video-insight version dist-tags
gh pr view 14667 --repo awesome-dsh-plugin/awesome-dsh-plugin
```
