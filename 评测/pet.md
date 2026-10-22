# 桌宠墨墨 ×《墨墨的洋馆》联动评测

> 执行人：pet-builder ｜ 2026-10-20 22:2x ｜ 范围：只在桌宠工程内改动，未改动游戏 `dist/` 与 `墨墨上线包.zip`。

## 结论

「去洋馆」入口已从焊死旧构建升级为**按 mtime 实时选最新构建**：jam 目录每次 rebuild 后，
桌宠下一次打开洋馆就是新版，不用重打桌宠。已用 Node 单测（13 例）+ 开发态 Electron +
**打包后 .app** 三轮验证，均确认解析到并成功加载 `~/Desktop/墨墨-涌现game jam/dist/index.html`（截图见
`~/Documents/deepseek-harness/default-workspace/assets/game-shot.png`）。macOS arm64 应用已重打并复制到
`发布/桌宠-墨墨.app`（303 MB）。

## 改了什么

| 文件 | 改动 |
| --- | --- |
| `default-workspace/src/main/game-path.js`（新增，83 行） | 可测试的入口解析模块：`autoCandidates()` 列出 jam 构建/旧构建/随包构建；`pickNewest()` 在多候选中取 mtime 最新；`resolveGamePathInfo()` 先吃 `MOMO_GAME_PATH` → `config.gamePath` 显式覆盖，再走自动发现。文件头有「实时更新」选择逻辑的长注释。 |
| `default-workspace/src/main/main.js:12` | 引入 `game-path` 模块。 |
| `default-workspace/src/main/main.js:764-768` | 删掉原先写死旧路径的 `resolveGamePath()`，改为每次打开前带 `config` 调用新解析器。 |
| `default-workspace/src/main/main.js:781` | `MOMO_DEBUG=1` 时打印实际入口与命中来源（`auto:newest-mtime` / `env` / `config`），便于排查。 |
| `default-workspace/src/main/main.js:782` | 找不到构建时的通知文案更新为新 jam 路径。 |
| `default-workspace/src/main/main.js:806-812` | 洋馆窗口补 `did-finish-load` / `did-fail-load` 日志（原先加载失败静默）。 |
| `default-workspace/src/main/main.js:1536-1538` | 冷启动 `electron . --game` 也会直接开洋馆（原先 `--game` 只在 second-instance 里处理）。 |
| `default-workspace/src/main/main.js:1541-1574` | 半自动验收钩子 `MOMO_TEST_GAME=1`：解析入口 → 开洋馆 → 截游戏窗口（`MOMO_TEST_GAME_SHOT`）→ 退出；加载失败/超时返回非 0。 |
| `default-workspace/test/game-path.test.js`（新增） | 13 个单测：真实 fs 命中 jam、多候选按 mtime、重建后切换、旧构建回退、随包候选、两种显式覆盖、覆盖失效回退、全缺失返回 null、目录跳过、mtime 打平顺序、绝对路径、真实临时目录重建。 |
| `default-workspace/package.json:12` | 新增 `npm run test:game-path`。 |
| `default-workspace/package.json:13` | `npm run pack` 加 `--electron-zip-dir=.electron-cache`（离线打包，避免 `fetch failed`），并扩充 ignore：`node_modules`、`projects/ux-review/发出/使用手册/archive/dist-win/.pylibs/.skill/backups/评测/发布`、`assets/psd|source`、各类截图 png；产物从 359 MB 降到 323 MB。 |

未改：游戏 `dist/index.html`、`墨墨上线包.zip`、TapTap 投稿相关文件；`发布/` 与 `评测/pet.md` 为新增。

## 怎么验证的

```bash
cd ~/Documents/deepseek-harness/default-workspace

# 1) 单测（不依赖 Electron）
npm run test:game-path          # -> 13 tests passed

# 2) 开发态：打开洋馆并截游戏窗口
env -u ELECTRON_RUN_AS_NODE MOMO_DATA_DIR=.userdata MOMO_DEBUG=1 \
    MOMO_TEST_GAME=1 MOMO_TEST_GAME_SHOT=assets/game-shot.png MOMO_TEST_GAME_WAIT=6000 \
    ./node_modules/.bin/electron . --game
# 日志：test resolve / resolved -> ~/Desktop/墨墨-涌现game jam/dist/index.html
#      loaded: ... jam dist/index.html；shot saved: assets/game-shot.png (2560x1544)

# 3) 打包后 .app 同样验证
env -u ELECTRON_RUN_AS_NODE MOMO_DATA_DIR=.userdata MOMO_DEBUG=1 MOMO_TEST_GAME=1 \
    MOMO_TEST_GAME_SHOT=/tmp/momo-pack-game-shot2.png \
    "dist/墨墨-darwin-arm64/墨墨.app/Contents/MacOS/墨墨"
# 日志同为 jam 构建路径，游戏窗口成功截图；exit=0
```

- 真实 mtime 证据：jam `dist/index.html` = 2026-10-20 22:05:55，旧构建 = 14:28:17，解析命中 jam；
  单测还把旧构建文件 mtime 改新，确认会跟随 mtime 切换（模拟任意一边重建都能正确选最新）。
- 截图 `assets/game-shot.png` 显示洋馆标题界面 + 首次取名弹窗（「你叫什么名字？」），
  说明加载的是可交互的最新构建，而不是空白/旧版页面。
- 打包产物内 `app.asar` 含 `/src/main/game-path.js`，运行同一套验证通过，确认打包没有丢新代码。

## 打包产物

| 项 | 值 |
| --- | --- |
| 原始产物 | `default-workspace/dist/墨墨-darwin-arm64/墨墨.app`（303 MB；整目录 323 MB 含 Electron 许可证文件） |
| app.asar | 12,993,974 B（已剔除开发素材/截图/旧目录/node_modules） |
| 复制到发布目录 | `墨墨-涌现game jam/发布/桌宠-墨墨.app`（303 MB，`ditto` 拷贝） |
| 构建命令 | `npm run pack`（electron-packager 20.3.0 + electron 44.9.0 arm64，本地 zip 缓存） |
| 游戏包 | `墨墨上线包.zip` 144,914,416 B，**未改动** |

## 如何让入口一直最新

- 自动：`openGame()` 每次都重新解析；自动候选里选 mtime 最新。游戏 rebuild → `dist/index.html` mtime 变新 →
  下次点「去洋馆」即新版；旧构建目录留着也不会抢。
- 手动兜底：`MOMO_GAME_PATH=/abs/path/dist/index.html` 或设置 `config.gamePath` 强制锁定；
  两者存在即用，适合把游戏放在非默认目录/分发给别人。
- 若洋馆窗口已经开着，重建不会自动刷新该窗口；关掉再开即可（这是最小实现，没有做热重载）。

## 遗留风险（按优先级）

1. **macOS 签名/公证缺失**：未 Developer ID 签名、未 notarytool 公证。别人机器首次打开会被 Gatekeeper 拦，
   需右键→打开或 `xattr -dr com.apple.quarantine`。正式上架前必须补签名+公证，否则分发体验差。
2. **仅 arm64**：Apple Silicon 专用；Intel Mac 需要 `--arch=x64` 另打（Electron 44 仍支持）。
3. **Windows 未更新**：`dist-win/` 是旧产物，本次只交付 macOS。
4. **TapTap H5 不能内嵌原生 app**：投稿包只能是网页 zip（≤300 MB）。已按「桌宠 .app 与游戏包并列分发」实现，
   `墨墨上线包.zip` 内含不了桌宠；本目录 README 已写清原因。
5. **桌宠不含游戏本体**：只拷 `.app` 到别的机器，若游戏不在默认位置会提示找不到构建；需同时分发游戏
   （zip 或 dist 目录）并放到约定路径/设 `MOMO_GAME_PATH`。发布目录未复制 138 MB 游戏 zip（避免堆体积）。
6. **无自动更新/无签名更新通道**：更新桌宠要手动替换 `.app`；游戏更新靠 mtime 自动生效。
7. **本地文件加载假设**：游戏以 `file://` + `loadFile` 加载（带 `nosw=1` 关 Service Worker）。若游戏后续依赖
   http 服务/跨域资源，需改为本地静态服务器方式（`openGame()` 小改）。
8. **打包依赖本地 Electron zip 缓存**：`--electron-zip-dir=.electron-cache` 是离线兜底；换机器需先有对应
   `electron-v44.9.0-darwin-arm64.zip`，否则会走下载。
9. **图标提示**：打包日志有 `.icon`（macOS 26 Icon Composer）格式缺失 warning，属于可忽略；实际
   `assets/icon.icns` 已正确拷进 `Contents/Resources/electron.icns`。
10. **发布目录占用**：`发布/桌宠-墨墨.app` 303 MB + 游戏包 138 MB，评测/提交系统若限制体积需用路径说明代替拷贝。
