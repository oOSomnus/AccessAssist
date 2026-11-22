# mac-voiceover 分支说明

这个分支是 **Mac + VoiceOver + Chrome 上能正常使用的版本**。它基于 main 的 `cc383ee`（PR #9 合并后），**不打算直接合并回 main**。main 保持在 Windows + Narrator 上验证过的稳定状态，不受 Mac 改动影响。

在 Mac 上用的时候，切到这个分支（`git switch mac-voiceover`），然后在 `chrome://extensions` 里重新加载扩展。

## 为什么不合并进 main

- Mac 上的问题大多来自 macOS 自身：系统级语音处理、iPhone 连续互通麦克风、VoiceOver 的朗读方式。Windows 上不会遇到这些。
- 最核心的一处改动改变了收音的设计。main 在所有平台上都要求**系统级回声消除**（`echoCancellation: 'all'`），这样读屏软件的声音不会被识别成指令。在 Mac 上这条路走不通（见下文），所以这个分支在 Mac 上改用 Chrome 自带的回声消除，再加一道"等安静再开始听"的保护。这个取舍只在 Mac 上验证过。
- Yihang 正在 main 上重构 agent protocol，这时候把平台相关的改动混进去，容易冲突，也不好排查。

## 提交

| 提交 | 内容 | 影响哪些平台 |
|---|---|---|
| `8c56e81` fix(panel) | 在 Mac 上测出来的**通用 bug 修复** | 所有平台。建议在 Windows + Narrator 上验证后，单独挑这个提交合回 main |
| `c35f77e` feat(mac) | **只在 macOS 上生效**的改动 | 只有 Mac。Windows 和 Linux 上，代码走和 main 完全相同的分支 |
| （本文件） | 说明文档 | — |

## 一、只在 Mac 上生效的改动（`c35f77e`）

### 1. 收音改用 Chrome 自带的回声消除，不用 macOS 系统级回声消除
- **现象：** 第一次说话完全听不到，识别卡在半句话上，后来干脆报 "Chrome could not start speech recognition"。另外 "Listening." 也听不见。
- **原因：** 在 Mac 上，`echoCancellation: 'all'` 会让麦克风经过 macOS 的语音处理模块（Voice Processing I/O）。它有两个副作用：一是把其他应用的声音都压低，VoiceOver 刚说 "Listening"，麦克风一开就被压得几乎听不见；二是 Chrome 的本机识别器从这条音轨上经常收不到声音，或者中途卡住。
- **证据：** 在测试用的 Mac（Chrome 156）上做了对比。系统级回声消除的音轨，麦克风电平有 0.62（说明录到了声音），识别器却**一个事件都没有**；Chrome 自带的回声消除和默认麦克风，识别器 0.2 秒内就开始出文字。
- **代码：** `speech.js` 的 `captureConstraints()` 和 `captureCancelsEcho()`。Mac 请求 `echoCancellation: true`，其他平台不变。

### 2. 指定麦克风，避开 iPhone 连续互通麦克风
- **现象：** 第一次收听时，系统会把麦克风切到附近的 iPhone 上。iPhone 不在嘴边，听不清；iPhone 一离开，音轨就自己断了，报 audio-capture。
- **做法：** 开麦前先列出所有设备。如果当前默认麦克风是 iPhone 或 iPad，就改用 MacBook 自带的；否则锁定当前这个具体设备，免得收听途中被系统切走。如果锁定的设备已经不在了，就退回默认麦克风。
- **代码：** `speech.js` 的 `pickInputDevice()` 和 `preferredInput()`。

### 3. 等麦克风安静了再响提示音
- **现象：** 改用 Chrome 的回声消除后，VoiceOver 自己说的话会被识别进指令，比如 "Listen button, Actions region"、"You are currently on a button…"。
- **原因：** Chrome 的回声消除只能消掉 Chrome 自己发出的声音，VoiceOver 不属于 Chrome，消不掉。
- **做法：** 麦克风打开后，先监测输入电平，等连续 0.7 秒没有声音（最多等 8 秒）再响两声提示音。提示音之前录到的内容本来就会被丢掉，所以 VoiceOver 的播报不会混进指令。
- **代码：** `speech.js` 的 `waitForQuietInput()`。

### 4. 冷启动时推迟 "Listening."
- 面板刚打开时，VoiceOver 会忽略马上写进提示区域的内容。所以在 Mac 上，等面板加载满 1 秒后再说 "Listening."。
- **代码：** `sidepanel.js` 的 `listenOnce()`，用 `COLD_PROMPT_SETTLE_MS` 控制。

### 5. AI 按 Ctrl/Cmd+A、Z、Y 时明确告诉 Chrome 要做什么
- CDP 发出的按键不经过 macOS 的按键绑定，所以在 Mac 上 Ctrl+A 不会全选。现在会明确指定编辑命令：A 对应 selectAll，Z 对应 undo，Shift+Z 和 Y 对应 redo。其他平台本身就会执行这些组合键，所以不加，避免撤销两次。
- 修复了 Mac 上唯一失败的端到端测试 `interactions.spec.js` 里的 "Control plus A"。
- **代码：** `background.js` 的 `macEditCommand()`。

## 二、通用 bug 修复（`8c56e81`，在 Mac 上测出来，但所有平台都有）

1. **面板绑错标签页。** 新开一个标签页再输入网址，面板不会跟过去：新标签页激活时还是 `chrome://newtab`，被跳过了；网址加载完成时，`onUpdated` 又只认原来绑定的那个标签页。结果指令会读取、操作你看不见的那一页（测试中出现过来源确认列出的是另一个私人网站的情况）。现在页面加载完成时，前台标签页会被当作切换处理；没有任务进行时，按快捷键也会跟到你当前所在的页面。
2. **快速切换标签页时，面板换了页面却不播报。** 一次刷新已经换了绑定，却在播报前被更新的刷新取代，两边都不播报。现在由最后完成的那次刷新负责补上播报。
3. **按数字键后有最多 6 秒的空白。** 问题回答之后，它在播报区里仍然占满 6 秒，"Selected option N" 和后续步骤只能排在后面。而按下 Control 的那一刻 VoiceOver 已经停止朗读，所以用户听到的是一段空白。现在问题一被回答，就立即结束它占的时间。
4. **收听中途麦克风断开时，提示语不对。** 原来说 "No microphone is available. Connect one."，可麦克风明明在。现在改为 "The microphone stopped while listening."，并且语音保持就绪，可以直接再按一次。
5. **调试日志补充：** 识别器和麦克风的事件（开始、检测到说话、中间和最终结果、错误、重启、结束原因）、收听被取消、面板显示或隐藏。之前日志看不出指令是在哪一步丢的。

## 测试

- 单元测试 166/166 通过。
- 端到端测试 142 个通过，1 个跳过：在 Mac 上跳过了"没有系统级回声消除就拒绝录音"那条，因为 Mac 现在不再要求系统级回声消除，这条在其他平台上照常运行。main 上 Mac 唯一的失败（Ctrl+A）已经修好。
- 在真机（Mac + VoiceOver + Chrome 156 + 真 AI）上实测：第一次就能听到说话，VoiceOver 的话不会混进指令，"Selected option" 立即读出，新标签页会跟过去。

## Mac 上建议的 VoiceOver 设置（录屏用）

在 VoiceOver 实用工具里：
- **Web → General → Automatically speak the webpage**：关掉。不然按快捷键打开面板时，VoiceOver 会把整个面板从头读一遍。
- **Verbosity → Hints**：建议关掉。不然每次按快捷键后，VoiceOver 会多读 5 秒左右的按钮操作提示，提示音要等它读完才会响。

另外，OpenCode 组织的隐私地区要选 **Global**，否则默认模型 `deepseek-v4.1-flash` 每次都会返回 400。录屏时最好用只装 AccessAssist 的 Chrome 用户配置，避免「沉浸式翻译」之类扩展的悬浮按钮被 AI 当成页面内容。

## 还没解决的问题

- **播报顺序：** 按 Ctrl+Shift+Y 后，先说 "Listening."，接着 VoiceOver 播报面板，最后才响提示音。更好的顺序是把 "Listening." 挪到提示音前面。
- **本机识别准确率一般**，比如 "Read" 经常被听成 "With"。
- **拒绝来源后，页面标题和网址仍会发给 AI**（系统提示里每次都带 "Current page: 标题; address: 网址"）。
- **拒绝来源后，AI 会编一个看起来像授权的问题来劝用户允许。**
- **每次收到识别结果后，要等约 3 秒才调用 AI**，等的是 "I heard: …" 这条提示占的时间。
