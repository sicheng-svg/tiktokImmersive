# Douyin English MVP

这是一个面向 PC Chrome 的抖音网页版双语字幕与英文沉浸式体验实验项目。仓库已经完成 **Phase 1–5.1** 的当前视频检测、可靠媒体绑定和标准 WAV 提取，并已实现 **Phase 6** 的 Provider 可替换 ASR、上下文翻译、分层缓存和字幕 Overlay 架构；真实 Provider 与真实 Chrome 验收仍待完成。

Phase 6 的正常链路保留视频原来的中文声音：扩展取得当前作品的可靠媒体地址，后端安全下载并转换为 `mono / 16 kHz / 16-bit PCM WAV`，随后依次生成带时间戳的中文 `transcript` 和中英 `subtitles`，扩展按 `video.currentTime` 显示“双语 / 仅英文 / 关闭”三种字幕模式。字幕模式不会加载 `test.mp3`，也不会修改视频的 `muted`、`volume` 或播放速度。

当前实现阶段默认使用带醒目标记的确定性 Fake ASR 与 Fake Translation Provider，只用于验证领域接口、校验、缓存、状态机、API 和 Overlay，**不能代表真实识别或翻译结果**。真实 Provider、模型、凭证、费用和网络路径需要稍后确定并在本地 `backend/.env` 配置；英文 TTS、口音保留和真实英文语音不在 Phase 6。

## 当前能力

- Chrome Manifest V3、TypeScript、Vite
- Popup 中可持久化的智能字幕总开关
- 中英双语、仅英文、关闭三种字幕模式和 Debug Mode
- 使用 `querySelectorAll("video")` 建立候选视频集合
- `IntersectionObserver`、可见面积与播放状态联合评分
- `MutationObserver` 监听抖音动态新增、移除和复用的视频节点
- 作品 ID 优先、媒体 URL SHA-256 次之的稳定 `videoKey`
- 独立字幕 Overlay、连续播放时钟、seek 和重叠 cue 裁决
- 翻译失败时保留中文 transcript 并降级显示中文字幕
- 原视频声音始终保留，字幕失败不阻断用户继续看视频
- 页面 Debug 面板和统一模块日志
- 视频切换异步竞态保护，避免旧任务或字幕覆盖新视频
- FastAPI 健康检查、媒体任务创建与查询
- 面向 Chrome 扩展的可配置 CORS 和静态音频服务
- 后端请求校验、任务隔离与自动化测试
- 当前视频媒体来源 Strategy、任务提交和状态轮询
- `blob:` 视频的 aweme 响应捕获、三方作品 ID 绑定与到达顺序竞态保护
- 同作品多个已验证 CDN 地址保留和仅限下载类错误的受控回退
- HTTPS 媒体安全下载、SSRF 防护和逐跳重定向校验
- 固定浏览器兼容请求头和不泄露签名 URL 的 HTTP 状态诊断
- FFmpeg 本地音频提取与 WAV 格式复验
- 相同视频任务原子去重和旧视频异步结果隔离
- Provider 无关的中文 ASR 与上下文翻译接口及确定性 Fake
- transcript/translation 严格校验、原子文件缓存和进程内 single-flight
- `FETCHING → EXTRACTING → TRANSCRIBING → TRANSLATING → READY` 状态与步骤级缓存信息
- `transcript`、`subtitles` 和为后续英文 TTS 保留的空 `segments` API 契约

仓库仍保留 `DubPlayer`、`VideoAudioController`、`public/audio/test.mp3` 及其回归测试，供后续英文语音阶段复用；它们不再接入 Phase 6 生产内容脚本。

## 目录

```text
.
├─ README.md
├─ backend/
│  ├─ app/
│  │  ├─ api/
│  │  ├─ schemas/
│  │  ├─ services/
│  │  │  └─ language_processing/
│  │  ├─ config.py
│  │  ├─ middleware.py
│  │  └─ main.py
│  ├─ output/audio/
│  ├─ tests/
│  ├─ requirements.txt
│  ├─ requirements-dev.txt
│  └─ README.md
└─ extension/
   ├─ manifest.json
   ├─ popup.html
   ├─ public/audio/test.mp3
   ├─ scripts/
   │  ├─ build.mjs
   │  ├─ encode-test-audio.mjs
   │  └─ generate-test-audio.ps1
   ├─ src/
   │  ├─ background/
   │  │  ├─ requestValidation.ts
   │  │  ├─ serviceWorker.ts
   │  │  └─ videoTaskGateway.ts
   │  ├─ content/
   │  │  ├─ audioSourceProvider.ts
   │  │  ├─ capturedAwemeSources.ts
   │  │  ├─ debugPanel.ts
   │  │  ├─ dubPlayer.ts
   │  │  ├─ index.ts
   │  │  ├─ subtitleOverlay.ts
   │  │  ├─ videoProcessingCoordinator.ts
   │  │  ├─ videoAudioController.ts
   │  │  ├─ videoDetector.ts
   │  │  ├─ videoKey.ts
   │  │  └─ videoObserver.ts
   │  ├─ page/
   │  │  └─ mediaCaptureHook.ts
   │  ├─ popup/
   │  ├─ services/
   │  ├─ types/
   │  ├─ shared/
   │  │  └─ awemeMediaCapture.ts
   │  └─ utils/
   │     └─ mediaUrlPolicy.ts
   └─ tests/
```

## 扩展本地运行

需要 Node.js 20 或更高版本，以及桌面版 Google Chrome。

```powershell
cd D:\code\codex\tiktok\extension
npm install
npm run typecheck
npm test
npm run build
```

构建结果位于 `extension/dist`。加载扩展：

1. 打开 `chrome://extensions/`。
2. 开启右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择 `D:\code\codex\tiktok\extension\dist`。
5. 打开或刷新 `https://www.douyin.com/`。
6. 点击 Chrome 工具栏中的 Douyin English 图标，开启“智能字幕”。

扩展更新后需要重新执行 `npm run build`，再到 `chrome://extensions/` 点击该扩展的刷新按钮，并刷新抖音页面。

## 后端本地运行

需要 Python 3.11 或更高版本，以及 FFmpeg。首次安装并启动：

```powershell
cd D:\code\codex\tiktok\backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
Copy-Item .env.example .env
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload --env-file .env
```

访问 `http://127.0.0.1:8000/health` 应返回 `{"status":"ok"}`，交互式 API 文档位于 `http://127.0.0.1:8000/docs`。完整接口示例和测试命令见 [backend/README.md](backend/README.md)。

服务必须绑定 `127.0.0.1`，不能暴露到局域网或公网。首次真机测试时，Chrome 可能要求授予扩展访问本地网络的权限；打开扩展 Popup 会自动检查 `/health` 并触发相应提示。

安装 FFmpeg 或修改用户 `PATH` 后，请重新打开 PowerShell。若仍无法执行 `ffmpeg -version`，可在 `backend/.env` 中把 `DOUYIN_ENGLISH_FFMPEG_BINARY` 设置为 `ffmpeg.exe` 的绝对路径。

## Phase 1–3 播放器原型回归

早期用于验证英文音轨同步的 `DubPlayer` 和 `VideoAudioController` 已从生产内容脚本解除绑定，但模块、测试音频和单元测试仍保留。`npm test` 会继续验证播放、暂停、跳转、倍速、切换视频和音量恢复逻辑，供后续真实英文语音阶段复用。不要把加载 `test.mp3` 或静音原视频作为 Phase 6 的手动验收步骤；如果正常字幕链路出现这些行为，应视为回归缺陷。

## Phase 5/5.1 媒体绑定回归

先启动后端，再重新构建并加载扩展。打开 Popup，确认“本地后端已连接”；随后开启 Debug Mode 和智能字幕，在抖音播放一条普通视频。

1. 普通直链视频应显示 `Source provider: video-element`；成功绑定的 `blob:` 视频应显示 `Source provider: aweme-response` 和 `Source confidence: bound`。
2. Debug 面板中的 `Task` 应由 `none` 变为任务 ID，stage 依次进入 `FETCHING` 和 `EXTRACTING`，随后才进入 Phase 6 的语言处理阶段。`SUBMITTING` 很短，未观察到不代表失败。
3. WAV 提取成功后应显示可访问的 `/audio/{task_id}/audio.wav` 地址；磁盘中应存在 `backend/output/audio/{task_id}/audio.wav`。后续 ASR 或翻译失败时，该 WAV 仍应保留。
4. 打开该地址，确认 WAV 内容来自当前作品，而不是上一条或预加载视频。
5. 连续快速切换视频，旧任务完成后不得覆盖当前视频的状态。
6. 首选 CDN 地址被拒绝且响应中有备用地址时，扩展可以受控重提；最终仍失败时，错误中会显示安全的 HTTP 状态码，但不会显示签名参数。
7. 找不到可靠绑定、遇到 HLS/DASH、超限或后端失败时，应显示来源不可用或 `ERROR`，原视频仍正常播放。

建议结合 Chrome DevTools 的 Network 面板验证至少 10 条普通视频：页面实际请求的资源、Debug 面板选中的 URL 和生成的 WAV 必须属于同一作品。Phase 5 只生成标准化 WAV，不会把它当作英文配音播放。

## Phase 6 架构验收

默认 `.env.example` 使用 Fake Provider，不访问外网，也不需要 API Key。它适合验证整条技术链，但字幕会带有 Fake 标记，不能用于评估识别或翻译质量。

1. 启动后端并加载新构建的扩展，开启智能字幕，stage 应经过 `FETCHING → EXTRACTING → TRANSCRIBING → TRANSLATING → READY`。
2. READY 响应应同时包含非空 `transcript`、非空 `subtitles`、空 `segments` 和步骤级 `cache_hit`；`audio_url` 仍是中文 WAV。
3. 双语、仅英文和关闭三种模式应立即切换，不重新提交后端任务；播放、暂停、seek 和视频切换时字幕应跟随当前视频。
4. 翻译失败时任务保持 `ERROR / TRANSLATING`，但双语模式应使用已有 transcript 降级显示中文字幕；ASR 失败时不显示伪造字幕。
5. 全程检查原视频 `muted`、`volume` 和 `playbackRate` 不变，Network 中不得出现 `audio/test.mp3` 请求。
6. 保留 `backend/cache` 后重启服务，再处理相同内容，应创建新 task 且分别报告 ASR、翻译磁盘缓存命中；这与内存中的 `task_reused` 是不同概念。

真实 Provider 准备好后，还需要另做 3～5 条中文口播短视频的识别质量、上下文翻译、费用、网络和真实 Chrome Overlay 验收。完整门禁见 [Phase 6 Todo](docs/phase-6-asr-todo.md)。

## 开发命令

```powershell
npm run typecheck       # TypeScript 静态检查
npm test                # Vitest 单元测试
npm run test:watch      # 测试监听模式
npm run build           # 生成 Chrome 可加载的 dist
npm run generate:audio  # 仅为旧播放器回归重新生成测试 MP3
```

仓库已经包含生成好的 `public/audio/test.mp3`，Phase 6 的运行、开发和构建都不需要执行 `generate:audio`。重新生成音频仅支持带有 `System.Speech` 的 Windows 环境，不会调用在线 TTS 服务，也不需要 API Key。

## 实现边界与已知限制

Phase 6 只交付“原中文音频 + 可同步的中英字幕”。`audio_url` 指向中文 WAV，`segments` 为后续英文 TTS 保留并保持为空；当前不生成、播放或缓存真实英文配音，也不做声音复刻、口音迁移、人声/BGM 分离或混音。未来英文语音应通过独立 endpoint/job 消费已验证的 `subtitles`，不能反向改写 Phase 6 的字幕时间轴。

Fake Provider 不会上传音频或文字。接入真实服务后，数据边界应保持为：ASR 只接收本地 WAV，Translation Provider 只接收规范化 transcript；不得上传媒体签名 URL、Cookie、页面 DOM、标题或评论。API Key 和显式代理凭证只能保存在未纳入 Git 的 `backend/.env`，真实调用会产生费用并需要单独验收网络、限制和超时。

抖音页面结构和 CDN 策略会持续变化。检测逻辑不依赖某个固定 CSS class，但真实页面仍可能出现全屏播放器、直播、广告、特殊卡片、Worker 内请求、导航 HTML 中的初始数据、HLS/DASH、过期签名或需要登录态的媒体地址。Phase 5.1 只捕获顶层页面 `fetch`/XHR 返回的目标 JSON；未建立作品级因果绑定时会拒绝猜测。Performance Resource 适配器仍隔离保留且默认禁用；实现不会导出 Cookie、绕过 DRM 或让 FFmpeg 访问远程清单。

Phase 6 的 Provider 无关架构可以在 Fake 模式下本地验收；真实 Provider Adapter、凭证 smoke test 和 Chrome E2E 完成前，Phase 6 仍不视为最终交付。具体进度、任务拆分和验收门禁见 [Phase 6 ASR Todo List](docs/phase-6-asr-todo.md)。
