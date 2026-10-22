# 《墨墨的洋馆》语料库模块（MomoCorpus）实现与自测

> 评测对象：`game/js/corpus.js`（新建，1538 行）+ `game/js/chat.js`（只加事件派发）+ `_tools/build_dist.py`（只加 1 项 SRC_JS）
> 构建：`bash _tools/build_locked.sh`（**未加 `--zip`**），产物 `dist/index.html` 1.99 MB / 22:31 重建
> 自测日期：2026-10-20 22:20–22:31 · 距 jam 截稿约 13 小时
> 自测脚本与原始数据：`/tmp/corpus-test/test.js`、`edge.js`、`results.json`、`edge-results.json`
> 截图：`/tmp/corpus-test/shots/`（桌面 1920×1080、手机 844×390；已用 `read_image` 逐张看过）
> 作者 2026-10-20 P0 UI 修正已包含在本次构建中（语料按钮与「说 话」完全同款同尺寸、去掉按钮计数）。

---

## 0. 一句话结论

**`window.MomoCorpus` 已落地并接入构建：把玩家与墨墨的话分开沉淀成一份只存本机、按 profile+设备 uid 隔离的私人语料；AntConc 式 KWIC 检索 / 词频 / 三类过滤可用；EN/JA 对照按需、串行、限速、失败静默重试后本地缓存；打开时把词频 Top 12 广播给字海落字。** 主流程自测 61/61、边界 5/5 全过，控制台无新增异常。唯一保留风险是「真实 `/chat` 翻译链路」未在本机网络环境实跑（`curl` 15s 超时），客户端链路用与真实响应同形状的拦截 SSE 验证。

---

## 1. 交付文件清单（严格按允许范围）

| 文件 | 改动 | 行数 |
|---|---|---|
| `game/js/corpus.js` | **新建**。IIFE、无外部依赖、`window.MomoCorpus` | 1538 |
| `game/js/chat.js` | 只加 `chatlog(who,text)` 助手 + 4 处 `momo:chatlog` 派发：`submit` 的 user 气泡、`finish` 的 assistant、`capOut` 的收尾句、`MomoChat.ask()` 的 user | 690（原 675） |
| `_tools/build_dist.py` | `SRC_JS` 在 `chat.js` 之后加 `os.path.join(GAME_JS, "corpus.js")`（第 102 行，1 项） | 810 |
| `评测/corpus.md` | 本文件 | — |
| `dist/*` | 上述构建脚本重新生成（构建会改 dist，作者/Lead 之后统一重打；**未生成 zip**） | — |

**未改**：`UI还原/`（PSD/CSS 一行未动）、`game/content/`、其它 `game/js/*`、`pages/`、`worker/`、`发布/`。构建期间其它同事对 `party.js` / `dialogues.json` / `chapters.json` / `发布/` 的改动原样保留，未回退。

`dist/index.html` 内联验证：`/* ===== corpus.js ===== */` 存在，`MomoCorpus` 1 处导出，`momo:chatlog` 4 处派发；`syncBtnScale` 0 处（P0 后已移除反缩放）。

---

## 2. 机制设计（评委一眼能看懂的「语言涌现」证据）

### 2.1 捕获：玩家的话与墨墨的话分开存
- `chat.js` 只负责派发：
  ```js
  document.dispatchEvent(new CustomEvent("momo:chatlog", {
    detail: { who: "user"|"momo", text, ts: Date.now() }
  }));
  ```
  不按 `bubble()` 派发，避免打开面板重建历史时把旧对话重复抄进语料。
- `corpus.js` 监听 `momo:chatlog`，写入条目：
  ```js
  { id, ts, who, text, room, floor, en, ja, tags }
  ```
  `en/ja` 初始为 `""`，`tags` 初始为 `[]`；`room/floor` 取 `MomoStore.state` 当时的房间/楼层。

### 2.2 存储：每个用户独立、绝不上传
- localStorage 键：`momo.corpus.v1.<hash(profile name + 本机随机 uid)>`
  - 本机 uid 存 `localStorage["momo.corpus.uid"]`（首次随机生成，24 位 hex）；
  - hash = 两轮 FNV-1a → 16 位 hex；实测 `momo.corpus.v1.fd62eaa27cccc7c4` 这类格式；
  - 同一浏览器换玩家名 = 另一把键；同名字换浏览器/清站点数据 = uid 变 = 另一把键。两库条目互不可见。
- 信封结构：`{ v, uid, profile, entries, notice, createdAt }`，`uid/profile` 用于排查；语料永不上传。
- 上限：最多 **2000 条**（FIFO 裁旧），单条 **2000 字**（截断）；配额写满时 `save()` 自动按 300→100 条降级重试，不崩。
- 清空：面板底部「清空我的语料」→ 二次确认弹窗 → 只清当前 profile 的 key；别的 profile 不受影响（实测两库条目数分别为 0 / 2）。

### 2.3 检索：AntConc 风格
- 检索框：英文单词 / 中文子串，大小写不敏感；同时匹配原文与已生成的 EN/JA。
- **KWIC**：命中词前后各约 18 字，命中处 `<mark>` 高亮（`…前文『命中』后文…`）。
- 过滤：tab「全部 / 我的输入 / 墨墨的话」+ 时间「全部 / 今天 / 近 7 天 / 近 30 天」+ 对照「全部 / 已对照 / 未对照」；顶部实时结果计数。
- **词频榜**：英文按词（小写、去句尾撇号）、日文按「假名块 / 汉字块」、中文按相邻 2 字组合；内置小停用词表（EN/JA/ZH 三张）；点词频词 = 直接把检索框设为该词并过滤。
- 结果列表：时间、说话人（你 / 墨墨）、房间+楼层、KWIC、EN/JA 行、逐条「生成 EN / 生成 JA」；长文本可点开。

### 2.4 EN / JA 对照：按需、串行、限速、只存本机
- 复用聊天同一端点 `https://momo-chat-api.pages.dev/chat`（或 `window.MOMO_CHAT_URL`），`text/plain` 免预检（与 `chat.js` 一致）。
- 翻译 prompt：一次一句，要求「只输出一行译文、保持傲娇/微毒舌语气、不要引号/解释」。
- 队列：全局串行，请求间隔 ≥1.2s；失败**静默重试一次**，仍失败只更新底部状态，不弹报错、不影响聊天。
- 缓存：结果写回条目 `en/ja` 并立即 `save()`，下次打开/刷新直接命中，不重复请求。
- 首次点击弹一次说明：「会把这句话发给 AI（和『说 话』同一个接口），仅用于生成对照；结果只存这台设备；不会自动翻译全部」；取消则下次再问，确认后写 `store.notice=true`。
- 批量对照：只处理当前筛选结果里缺对照的条目，一次最多 8 个请求（4 句×2 语言），串行跑完给状态；不自动全量翻译。
- 导出：本机 Blob 下载 `momo-corpus-<profile>-<date>.json`。

### 2.5 与「涌现」的联动
- 打开语料库：取当前词频 **Top 12**，派发
  ```js
  document.dispatchEvent(new CustomEvent("momo:corpus", { detail: { top: [...] } }));
  ```
  若 `window.MomoWordSea && MomoWordSea.fall` 存在，再调用 `MomoWordSea.fall(top.join(" "))`，让玩家自己说出的高频词当场落进字海（失败忽略）。
- **没有恢复常驻字海**：`wordsea.js` 一行未改，`AMBIENT=false` 保持。
- P0 后按钮不再显示条数；计数放在面板标题「墨墨 · 语料库 · N 句」+ 统计区（句/独立词/已对照）。

### 2.6 UI
- 主画面入口：`.momo-corpus-btn` 与 `.momo-chat-btn` **完全同款同尺寸同列**：
  - `right:76px; bottom:398px; height:62px; padding:0 28px 0 32px; border-radius:999px;`
  - 边框/底色/字体 `25px`/`letter-spacing:7px`/`text-indent:7px`/`backdrop-filter`/`box-shadow`/hover 全部逐条复制聊天按钮，只把 `bottom` 从 322 改成 398（322+62+14，间距 14px）；`.off`/story-lock 同样对齐；
  - 按钮文字只有「语 料」两个字，与「说 话」等宽；不显示数字/圆点。
- 浮层面板：羊皮纸渐变 + 金边，标题/统计/tab/检索/侧栏词频/结果列表/底部隐私与操作；样式全部由 `corpus.js` 注入 `<style id="momo-corpus-css">`，**没改 UI还原/**。
- 手机 844×390：面板固定贴视口（8px 边距）、内部滚动、字号可读；实测面板完整在视口内、主区可滚动、隐私说明可见。入口与「说 话」同宽同高同右缘、间距 = 14×舞台缩放，不出屏。
- 聊天面板打开时隐藏语料入口（等价聊天的 `.off` 行为），避免手机上压住聊天面板的关闭键；语料面板打开时也收起入口。

---

## 3. 自测（真实跑过）

### 3.1 环境与方法
- 真实 Chrome：`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
- `puppeteer-core@23`（`/tmp/pupp/node_modules`），headless
- 本地静态服务：`http://127.0.0.1:8788`（`dist/`）
- `bash _tools/build_locked.sh` 重建后测试（**未 --zip**）
- 聊天网络：请求拦截并 **abort**（走 `chat.js` 本地 canned 兜底，不依赖外网）
- 翻译网络：拦截并按 lang 返回与真实端点同形状的 **SSE 流**（含 CORS 头），验证「请求 → 流式解析 → 写条目 → localStorage 缓存」全链路；未消耗作者真实 key
- 两个 profile 在同一浏览器里通过改写 `localStorage["momo.profile"]` 后 reload 验证
- 全程收集 `pageerror` 与 `console error`

### 3.2 结果：主流程 **61 / 61 通过**，边界 **5 / 5 通过**

| 组 | 验证点（全部实际断言） | 结果 |
|---|---|---|
| 入口/P0 | 只显示「语 料」；桌面与「说 话」同宽 146.25×62、右缘均 1844、间距 14px、底边 682；字号/字距/内边距/圆角/底色一致；手机 844×390 均 52.81×22.39、右缘均 741.22、间距 = 14×缩放、不出屏 | ✅ |
| 捕获 | 3 句聊天后 user 3 / momo 3、共 6 条；字段完整；聊天打开时入口隐藏、关闭恢复 | ✅ |
| 存储/隐私 | 键格式 `momo.corpus.v1.<16hex>`；带 uid/profile；A/B 两 profile 键不同、B 初始 0 条看不到 A；B 聊 1 句得 2 条；切回 A 仍 6 条且对照保留 | ✅ |
| 检索 | 搜「今天」命中且 KWIC `<mark>` = 今天；词频点击自动回填搜索框并过滤；高亮仍在 | ✅ |
| 过滤 | tab「我的输入 / 墨墨的话」各 3；「已对照」条数 = aligned；「今天」6 条 | ✅ |
| 对照 | 首次弹说明且文案含「仅用于生成对照 / 只存这台设备」；EN/JA 分别写入并显示；结果进 localStorage；批量后 aligned 5；翻译请求带 en/ja prompt | ✅ |
| 清空 | 二次确认弹窗；确认后当前 profile 0 条、localStorage entries=[]、按钮仍只有「语 料」；B 的 2 条没被碰（两键条目 [0,2]） | ✅ |
| 涌现 | 打开广播 `momo:corpus` 且 `top` 长度 12；`MomoWordSea.state().falls > 0`（落字被调用） | ✅ |
| 移动端 | 面板完整在视口内、主区 `overflowY:auto` 且可滚（scrollTop>0）、隐私「只存这台设备/不上传」可见 | ✅ |
| 控制台 | `pageerror` 0；控制台无新增 error（仅剩故意 abort 聊天请求的 `net::ERR_FAILED`，已过滤） | ✅ |
| 边界 | 单条 2500 字 → 存 2000；2100 次 capture → 2000 条且 FIFO 裁掉最旧 m0–m99、保留 m100–m2099（耗时 898ms）；同名字换 uid → 另一把键且 0 条 | ✅ |

原始结果：`/tmp/corpus-test/results.json`（61 项逐条）、`/tmp/corpus-test/edge-results.json`（5 项）。

### 3.3 截图（均已 `read_image` 检查）
| 截图 | 内容 | 路径 |
|---|---|---|
| 桌面关闭态 | 1920×1080，语料/说话两按钮同宽同高右对齐、间距 14px | `/tmp/corpus-test/shots/desktop-main-closed.png` |
| 桌面语料库 | 1920×1080，标题「墨墨 · 语料库 · 6 句」、统计、词频侧栏、6 条 KWIC、EN/JA 对照、隐私与清空 | `/tmp/corpus-test/shots/desktop-corpus.png` |
| 桌面首次对照说明 | 翻译前的一次性说明弹窗 | `/tmp/corpus-test/shots/desktop-translate-notice.png` |
| 手机关闭态 | 844×390（DSF=2 截图 1688×780），两按钮同宽同高同列 | `/tmp/corpus-test/shots/mobile-main-closed.png` |
| 手机语料库 | 844×390，面板完整贴视口、内部滚动可读、标题带句数 | `/tmp/corpus-test/shots/mobile-corpus.png` |

![桌面关闭态（按钮对齐）](/tmp/corpus-test/shots/desktop-main-closed.png)
![桌面语料库](/tmp/corpus-test/shots/desktop-corpus.png)
![手机关闭态（按钮对齐）](/tmp/corpus-test/shots/mobile-main-closed.png)
![手机语料库](/tmp/corpus-test/shots/mobile-corpus.png)

---

## 4. 构建接线与产物证据

```bash
bash _tools/build_locked.sh          # 串行锁，内部 /usr/bin/python3；未 --zip
# 产物：dist/index.html 1.99 MB（22:31），assets/ 133.4 MB，合计 135.39 MB
```

- `dist/index.html` 内含 `/* ===== corpus.js ===== */`，`window.MomoCorpus` 可访问；
- 构建日志「处理 JS」「处理 HTML」「完成」全部正常，无 [跳过] corpus.js；
- 没有重新打 `墨墨上线包.zip`（按要求留给作者/Lead 统一重打）。

复现命令：
```bash
cd /Users/lucian/Desktop/墨墨-涌现game jam
bash _tools/build_locked.sh
cd /tmp/corpus-test && node test.js     # 61/61
cd /tmp/corpus-test && node edge.js     # 5/5（会占用一个新的临时浏览器 profile）
```

---

## 5. 遗留风险 / 需要作者或 Lead 拍板的事

1. **真实 `/chat` 翻译链路未实跑**：本机 `curl https://momo-chat-api.pages.dev/chat` 15s 超时（pages.dev 在测试环境不稳）。翻译客户端用「与真实 SSE 同形状 + CORS 头」的拦截响应验证，请求体/头/解析均复用 `chat.js` 已验证的形态；上线前建议作者在有网环境点一次「生成 EN」真测。
2. **翻译额度**：聊天有 120 条/日上限，语料翻译**没有单独日限**；手动逐条 + 批量一次最多 8 请求，正常试玩量不大，但反复点批量会消耗作者 key。若担心可加「每日 N 条翻译」软上限（本次未加，避免影响评委试玩）。
3. **改名 = 换库**：键含 profile name，玩家在设置里改名后会拿到一份新语料库；旧库仍在 localStorage 里但 UI 不可见（隐私设计如此）。若作者希望「改名迁移」需要另做（本次未做）。
4. **清站点数据/换设备 = 旧库不可见**：uid 是随机本机值，没有云端同步（作者要求不上传）；这是隐私换来的代价，UI 已写明「只存这台设备」。
5. **配额上限**：2000 条 × 每条最长 2000 字理论上可超 localStorage 5MB；`save()` 有降级裁剪兜底，但未在真 5MB 边界做压力测试（只压了 2000 条 FIFO 与 2000 字截断）。
6. **EN/JA 语气质量**：prompt 要求保持傲娇/微毒舌、只输出一行；未被真实模型采样评估，翻译文风可能偏直。作者若有空可抽 3~5 句真跑看。
7. **P0 手机按钮**：按作者要求与「说 话」完全同款后，844×390 下两按钮都和聊天按钮一样小（52.8×22.4 CSS px），不再做反缩放放大——这是「同尺寸」的必然结果；如后续想要更大点击区，需要同时改 `.momo-chat-btn`（不在本任务允许范围）。
8. **隐私边界的说明**：打开语料库广播的是**词频**（本地事件，不发网络）；真正出网的只有玩家点击「生成 EN/JA」的那一句。面板底部文案已写死「只存这台设备、不上传、每个玩家独立」。

---

## 6. 一句话给评委的演示路径

主画面点「语 料」→ 看到「墨墨 · 语料库 · N 句」→ 搜一个自己说过的词（KWIC 高亮）→ 点词频里的词（自动检索）→ 点「生成 EN / JA」（首次说明 → 对照落回条目，只存本机）→ 收起，看她的字海落下你刚说过的词。不同玩家用不同名字重开，两库互不可见。
