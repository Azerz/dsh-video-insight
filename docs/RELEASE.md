# dsh-video-insight v0.8.0 发布手册

> 这是可以直接照做的 checklist。每步给出命令与期望输出；打勾的步骤已在 2026-11-18 03:20 +0800 核实过。
> 相关：QA 结论与遗留问题见 [`docs/QA.md`](./QA.md)。

## 当前状态快照

| 项 | 状态 |
| --- | --- |
| 版本号（`package.json` / `lib/index.js:62` / `README.md:6` 徽章 / `CHANGELOG.md` 顶部） | ✅ 全部 `0.8.0`，一致 |
| 代码提交 | ✅ HEAD `66b61f9`，`origin/main` 已同步（本地 0/0） |
| 工作区 | ⚠️ **不干净**（03:21 实测）：` D lib/bookmarks.js`、` M lib/index.js`、` M package.json`、`?? lib/outline.js`，`package.json` 已是 `0.9.0` → 这是进行中的 0.9.0，**不能从当前工作区发布 0.8.0**（打包会变成 0.9.0），必须用 tag/HEAD 的干净 worktree（步骤 0.5 ②，QA Q1-4） |
| Git tag `v0.8.0` | ⚠️ 指向 `eb0d2e6`，比 HEAD 落后 2 个 README 文档提交 → 发布前先对齐（步骤 0.5 / QA Q1-3） |
| GitHub Release | ❌ 还没建（tag 已存在，**不要**重建 tag） |
| npm 上 latest | ❌ 仍是 `0.4.8`（`versions` 只有 `0.4.8`） |
| 市场索引（`dsh-plugin-catalog`） | ❌ `0.4.8`（跟随 npm 同步） |
| marketplace PR `#14667`（awesome-dsh-plugin） | ✅ 已 MERGED（2026-11-13T20:20:43Z），更新版本**不需要**新 PR |
| 客户端测试 | ✅ `pass 282/282` |
| 实际宿主运行版本 | ⚠️ `0.7.0`（host 模块未重启，发布前要重启确认） |
| CI | 无（仓库没有 `.github/workflows`，所有门禁手工做） |

---

## 步骤 0：发布前门禁（约 5 分钟，全绿才继续）

```bash
cd /Users/zhujianyu/Desktop/Dsh-plugins/dsh-video-insight
```

### 0.1 工作树干净、与远端同步

```bash
git status --short                 # 期望：空（或仅 docs/QA.md、docs/RELEASE.md 未追踪）
git rev-list --left-right --count origin/main...HEAD   # 期望：0	0
git log -1 --oneline               # 期望：66b61f9 docs: 去掉首段与第二段的重复表述
git tag -l | tail -3               # 期望：包含 v0.8.0
```

- [ ] 以上都符合。若工作树有未提交改动：**先提交/丢弃/隔离到 worktree**，不要带着脏树发布。当前实测工作区是脏的（进行中的 0.9.0），所以建议直接跳到 0.5 方案 ②，用 `/tmp/vi-rel` 的干净树做后续所有步骤。

### 0.2 测试

```bash
node test/client.test.mjs
```

- [ ] 期望：`pass 282/282（282 项全部通过）`。

### 0.3 版本号四处一致

```bash
node -p "require('./package.json').version"      # 0.8.0
grep -n "const VERSION" lib/index.js             # 62:const VERSION = '0.8.0';
grep -n "img.shields.io/badge/dsh--video--insight" README.md   # 徽章 v0.8.0
head -6 CHANGELOG.md                             # 最新 ## v0.8.0（2026-11-18）
```

- [ ] 四处都是 `0.8.0`。

### 0.4 打包清单（不写磁盘）

```bash
npm pack --dry-run --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const p=j[Object.keys(j)[0]];console.log(p.id,p.size,p.unpackedSize,p.entryCount);console.log(p.files.map(f=>f.path).join('\n'))})"
```

- [ ] `id` 是 `dsh-video-insight@0.8.0`，**32 个文件**，含 `lib/*.js`(24) + `client/client.js` + `locale/{en,zh}.json` + `cordis.patch.yml` + `icon.svg` + `README.md` + `LICENSE` + `package.json`。
- [ ] 不含 `test/`、`docs/`（不发布是预期行为）。
- [ ] 若出现 `.DS_Store`、`*.tgz`、`*.log`、历史/凭证文件 → 停，先修 `.gitignore` / `files`。

### 0.5 tag 与 HEAD 对齐（发布前，**关键**）

```bash
git tag --points-at HEAD                     # 期望：v0.8.0
git rev-list --oneline v0.8.0..HEAD          # 期望：空
git diff --stat v0.8.0..HEAD                 # 期望：空
```

当前实测：`v0.8.0` 指向 `eb0d2e6`，`v0.8.0..HEAD` 有 2 个 README 文档提交（`31541fd`、`66b61f9`；`git diff --stat` = `README.md | 4 ++--`）。README 在 `files` 白名单里，所以「tag 的树」与「从 HEAD 打出来的包」内容会对不上（功能/版本/测试不受影响）。

另外当前（03:21）工作区混着未提交的 0.9.0 变更（`package.json` 已是 `0.9.0`、新增 `lib/outline.js`、删了 `lib/bookmarks.js`），**在工作区直接 `npm pack` 会打出 `dsh-video-insight@0.9.0`** —— 所以下面**推荐方案 ②**（用干净的 tag worktree，同时隔离 0.9.0 脏树）。

- [ ] 二选一（npm / GitHub Release 都还没落地，现在改 tag 还算安全）：
  - **① 对齐 tag**（需先把工作区弄干净，如 `git stash -u`）：
    ```bash
    git stash -u                     # 隔离进行中的 0.9.0，发布后可 stash pop
    git tag -f v0.8.0 HEAD
    git push -f origin v0.8.0        # 强制更新远端 tag
    git tag --points-at HEAD         # 期望：v0.8.0
    ```
  - **② 不动 tag，从 tag 的树发布（当前推荐）**：
    ```bash
    git worktree add /tmp/vi-rel v0.8.0
    cd /tmp/vi-rel                   # 步骤 1、2 都在这里做；工作区脏不脏都无所谓
    git status --short               # 期望：空（干净树）
    ```
    代价：npm 包和 GitHub Release 的 README 是旧首段，文档润色随 0.8.1 发。
- [ ] ⚠️ 一旦 npm publish 或 GitHub Release 已落地，就**不要再移动 tag**；后续修正改发 `0.8.1`。

### 0.6 重启宿主，确认运行态是 0.8.0（**关键**）

```bash
curl -s http://127.0.0.1:49269/dsh-video/api/status
```

- 现在返回 `"version":"0.7.0"` —— 重启 DeepSeek Harness（或重新激活该 bundle）后再跑一次。
- [ ] 期望：`"version":"0.8.0"`。
- [ ] 刷新页面，确认左栏「视频解析」入口和 7 个页签（总结/章节/原文/片段/分镜/关键画面/思维导图）都在。

### 0.7 可选但推荐的小修（不阻塞发布，可发布后随 0.8.1 做）

详见 `docs/QA.md` 第 7 节：

- [ ] Q2-1 `lib/index.js` 的 5 处 `readBody(req, { limit: … })` 改成数字实参（host bug）。
- [ ] Q2-2 `CONTRACT.md:16` 示例版本 `0.4.4` → `0.8.0`；`CONTRACT.md` 加进 `files` 或去掉 README 里的相对链接。
- [ ] Q2-3 `README.md:184`「最近 20 条」→「最近 100 条」。
- [ ] Q3-1/Q3-2 加 `engines.node` 与 `scripts.test`（改 `package.json` 会改变包内容，若此刻要发就留到下个补丁）。
- [ ] Q3-3 文件权限：`npm pack` 出来的 29/32 个文件是 `0600`（工作区 umask 所致；干净 clone 不受影响）。发布前执行一次：
  ```bash
  chmod -R u+rwX,go+rX lib client locale icon.svg cordis.patch.yml README.md package.json LICENSE CONTRACT.md CHANGELOG.md
  ```
  （只改权限位，不改内容。）

> 若决定立刻修 0.8.0：修完提交后回到步骤 0.5 重新对齐 tag（**npm publish / GitHub Release 之前才允许移动 tag**）。更稳妥：现在按 0.8.0 发布，修复合入后发 **0.8.1**；一旦发布过，tag 就不要再动。

---

## 步骤 1：本地打包校验（发布前最后一次看包）

```bash
cd /Users/zhujianyu/Desktop/Dsh-plugins/dsh-video-insight   # 若按 0.5② 发布：改为 cd /tmp/vi-rel
pwd && git status --short                                    # 期望：干净树；当前工作区脏（0.9.0）时不要在这里打包
rm -rf /tmp/vi-verify && mkdir -p /tmp/vi-verify/pkg /tmp/vi-verify/home
npm pack --pack-destination /tmp/vi-verify
tar -xzf /tmp/vi-verify/dsh-video-insight-0.8.0.tgz -C /tmp/vi-verify/pkg
find /tmp/vi-verify/pkg/package -type f | wc -l     # 期望 32
node --check /tmp/vi-verify/pkg/package/client/client.js && echo "client syntax OK"
HOME=/tmp/vi-verify/home node --input-type=module -e \
  "const m = await import('/tmp/vi-verify/pkg/package/lib/index.js'); console.log(Object.keys(m).join(','))"
```

- [ ] `npm pack` 输出的文件名必须是 **`dsh-video-insight-0.8.0.tgz`**；若是 `0.9.0` → 停下了，你打的是脏工作区（见 0.5 / QA Q1-4）。
- [ ] 期望导出：`API_PREFIX,VideoError,apply,buildDigestText,createResolver,name`。
- [ ] `HOME` 指到临时目录（`/tmp/vi-verify/home`），**不要在真实 `~/.dsh` 里留下测试文件**。
- [ ] 这一步验证的是「包自包含、解包即可被宿主加载」；已在本仓库实测通过。

---

## 步骤 2：`npm publish`（**需要人工在浏览器授权**）

> 这一步必须是人来做：npm 的发布操作会要求一次性验证 / 浏览器授权。子代理不执行发布。

```bash
cd /Users/zhujianyu/Desktop/Dsh-plugins/dsh-video-insight   # 若按 0.5② 发布：cd /tmp/vi-rel（干净树）
pwd                                                          # 核对，避免在错误目录发布
npm whoami                                                   # 期望：azerz
npm publish --dry-run                                        # 预演：只打包不发布；确认 id 是 dsh-video-insight@0.8.0
npm publish                                                  # 正式发布
```

操作要点：

- [ ] 先确认「要发布的树」与 tag 一致：`git rev-list --oneline v0.8.0..HEAD` 输出为空（若步骤 0.5 选了方案 ②，此时应在 `/tmp/vi-rel` 里、`pwd` 显示的是它）。
- [ ] `npm whoami` 是 `azerz`（npm 已登录；若过期先 `npm login`）。
- [ ] `npm publish` 若提示 **"This operation requires a one-time password"** 或给出浏览器 URL：在浏览器里批准（2FA / web-auth），批准后终端继续。**不要**把 OTP / token 贴进聊天、日志或提交。
- [ ] 包名无 scope，不需要 `--access public`（加了也无害）；**不要**顺手 `--tag next`，要发到 `latest`。
- [ ] 发布后立刻核对：
  ```bash
  npm view dsh-video-insight version dist-tags time --json
  npm view dsh-video-insight@0.8.0 dist.tarball
  ```
  期望：`version: "0.8.0"`、`dist-tags.latest: "0.8.0"`。

### 发布后包级验证（不依赖宿主）

```bash
rm -rf /tmp/vi-registry && mkdir -p /tmp/vi-registry/pkg /tmp/vi-registry/home
npm pack dsh-video-insight@0.8.0 --pack-destination /tmp/vi-registry
tar -xzf /tmp/vi-registry/dsh-video-insight-0.8.0.tgz -C /tmp/vi-registry/pkg
HOME=/tmp/vi-registry/home node --input-type=module -e \
  "const m = await import('/tmp/vi-registry/pkg/package/lib/index.js'); console.log(Object.keys(m).join(','))"
ls /tmp/vi-registry/pkg/package/lib | wc -l          # 期望 24
node --check /tmp/vi-registry/pkg/package/client/client.js && echo "client syntax OK"
```

- [ ] 从 registry 拉下来的包能直接 import、`client.js` 语法通过、文件数对。
- [ ] 可选：`mkdir -p /tmp/vi-install && npm install --prefix /tmp/vi-install dsh-video-insight@0.8.0 --no-audit --no-fund`，确认 `node_modules/dsh-video-insight/` 里 `cordis.patch.yml`、`icon.svg`、`locale/` 都在。

---

## 步骤 3：GitHub Release（tag 已存在，只建 Release）

```bash
cd /Users/zhujianyu/Desktop/Dsh-plugins/dsh-video-insight
# 从 CHANGELOG 的 v0.8.0 段落生成 notes
awk '/^## v0\.8\.0/{f=1;next} /^## v0\.[0-9]/{f=0} f' CHANGELOG.md > /tmp/release-notes-v0.8.0.md
cat /tmp/release-notes-v0.8.0.md

gh release create v0.8.0 \
  --title "v0.8.0 — 关键画面页签 / 历史搜索收藏 / 素材复用" \
  --notes-file /tmp/release-notes-v0.8.0.md
```

- [ ] `gh` 已以 `Azerz` 登录；没有 `gh` 就用网页：<https://github.com/Azerz/dsh-video-insight/releases/new?tag=v0.8.0>。
- [ ] **不要**重新创建 tag（已存在；若步骤 0.5 ① 对齐过，它此时指向 HEAD）；**发布后**不要再移动 tag。
- [ ] 在 notes 里点一句：npm 安装 `plugin_manager {"action":"install_bundle","target":"dsh-video-insight"}`，升级后需重启 App。

---

## 步骤 4：等待并验证市场索引同步

市场索引由 npm 上的 `dsh-plugin-catalog` 提供，插件版本号跟随 npm 发布自动带出（不需要为「发新版」再开 PR）。

```bash
# jsDelivr 带时间戳绕缓存
curl -s "https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json?ts=$(date +%s)" \
| node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const p=j.plugins.find(x=>x.name==='dsh-video-insight');console.log(JSON.stringify(p&&p.versions,null,1));})"
```

- [ ] 期望 `versions[0]` 变成 `0.8.0`。刚发布时可能仍显示 `0.4.8`，索引有构建/缓存延迟，等 10–30 分钟重试。
- 同时看两处页面：
  - <https://awesome-dsh-plugin.com/p/Azerz/dsh-video-insight/>（详情页）
  - <https://www.npmjs.com/package/dsh-video-insight>（包页）
- [ ] 若 **24 小时**后索引仍是 `0.4.8`：到 <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/issues> 开 issue，说明「npm 已发布 dsh-video-insight@0.8.0，index.json 未更新」，附上 `npm view` 输出。
- [ ] （可选，PR）该仓库的插件描述来自 `data/plugins/Azerz__dsh-video-insight.yml`，现在写的是「20-item history」、没提关键画面/分镜/片段。要更新描述就改这一个文件提一个 PR（**一个插件一个文件**，别改 README，README 是自动生成的）：
  `<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/data/plugins/Azerz__dsh-video-insight.yml>`

---

## 步骤 5：安装路径验证

> ⚠️ 当前开发 profile 是 **link 到本地目录**（`~/.dsh/profiles/desktop/package.json` 里 `"dsh-video-insight": "link:/Users/zhujianyu/Desktop/Dsh-plugins/dsh-video-insight"`）。**不要**为了验证 npm 包把开发 profile 改成 npm 版本，否则会丢开发态（要改回来得重新 link）。

| 路径 | 命令 | 期望 |
| --- | --- | --- |
| ① npm 安装 | 任意会话：`plugin_manager {"action":"install_bundle","target":"dsh-video-insight"}` | 装到 `0.8.0`（发布前会装到 0.4.8）；profile 里出现 semver 依赖 |
| ② 本地目录 | `plugin_manager {"action":"install_bundle","target":"/Users/zhujianyu/Desktop/Dsh-plugins/dsh-video-insight"}` | 写入 `link:/…`，刷新页面即生效（就是现在的开发态） |
| ③ 手工 | 编辑 profile 的 `package.json`（`dependencies` + `dsh.profile.bundles`）→ 该目录 `pnpm install` → 重启 App | 可用，但官方文档不建议手写 profile，仅兜底 |

验证安装结果（不依赖浏览器）：

```bash
curl -s http://127.0.0.1:49269/dsh-video/api/status     # "version":"0.8.0"
```

然后在页面里走一遍：左栏「视频解析」→ 粘贴一个 YouTube 链接 → 解析 → 总结/章节/原文/片段/分镜/关键画面/思维导图各点一次；再点一个时间戳确认播放器跳转。

- [ ] `/status` 显示 `0.8.0`，页面 7 个页签可切换。
- [ ] 若要验证 npm 安装路径又不想动开发 profile：另开一个临时 profile 装（不推荐动 desktop profile）。

---

## 步骤 6：回滚预案

| 场景 | 做法 |
| --- | --- |
| 刚发布就发现严重问题 | 30 天内可 `npm unpublish dsh-video-insight@0.8.0`（npm 政策，越早越稳）；或 `npm deprecate dsh-video-insight@0.8.0 "原因，建议降到 0.8.1"` |
| 代码问题 | `git revert <造成问题的提交>` → 提 `fix: …` → 升 `0.8.1` 重复本手册（**不要** force-push / 移动已发布的 tag） |
| 市场索引已更新且包被撤回 | 索引跟随 npm，等下一次同步；必要时按步骤 4 开 issue |
| 宿主加载失败 | 回退 profile 到上一个可用 bundle；`plugin_manager` 重新装 0.8.1 |

---

## 步骤 7：发布记录（填完留在 issue / 本地笔记）

| 时间 | 动作 | 命令 | 输出 / 结果 |
| --- | --- | --- | --- |
| | 门禁 0.1–0.4 | | |
| | 重启宿主确认 0.8.0 | `curl -s …/status` | |
| | `npm publish` | `npm publish` | 授权方式（2FA / 浏览器） |
| | 包级验证 | `npm pack dsh-video-insight@0.8.0` | |
| | GitHub Release | `gh release create …` | Release URL |
| | 索引同步 | `curl … index.json?ts=` | 版本 |
| | 安装验证 | `/status` | 版本 |

---

## 禁止清单（发布时最容易踩）

1. ❌ 在错误的目录 `npm publish`（先 `pwd`，只认发布树的根目录：仓库根，或步骤 0.5 ② 的 `/tmp/vi-rel`）。
2. ❌ `git push --force` / 移动或删除**已发布**的最终 tag（步骤 0.5 在发布前对齐 tag 属例外）。
3. ❌ 把开发 profile 从 `link:` 改成 npm 版本（会丢本地开发态）。
4. ❌ 在浏览器授权时把 OTP / npm token 发到聊天、issue、提交或日志。
5. ❌ 带着 `npm pack` 产生的 `.tgz`、`.DS_Store`、`~/.dsh` 凭证文件发布（确认 `.gitignore` 与 `files` 生效）。
