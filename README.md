# Douyin English MVP

这是一个面向 PC Chrome 的抖音网页版英文沉浸式配音实验项目。当前仓库已经完成 MVP 文档中的 **Phase 1–5**：浏览器端播放器控制链路，以及从当前视频直链到标准 WAV 的媒体提取链路。

当前版本可以安装为 Manifest V3 扩展，识别抖音页面中当前可见且正在播放的视频，在 English Mode 开启时保存并静音原视频音量，同步播放一个本地英语测试 MP3，并在暂停、继续、跳转或切换视频时同步控制测试音轨。关闭插件、切换视频或播放失败时，会恢复对应视频原来的 `muted` 和 `volume` 状态。

扩展会读取当前视频元素明确提供的 HTTPS 媒体直链。页面使用 `blob:` 时，全标签页的 Performance Resource 无法证明资源属于当前视频，因此当前生产路径会安全降级为来源不可用，不会猜测相邻预加载视频。Service Worker 将可靠来源提交给仅监听本机的 FastAPI 后端，后端经过域名、DNS、重定向、连接对端、大小和超时校验后下载媒体，再通过 FFmpeg 输出 `mono / 16 kHz / 16-bit PCM WAV`。当前仍不执行 ASR、翻译或真实 TTS。

## 当前能力

- Chrome Manifest V3、TypeScript、Vite
- Popup 中可持久化的 English Mode 开关
- 双语字幕模式、英语语速和 Debug Mode 的基础设置 UI
- 使用 `querySelectorAll("video")` 建立候选视频集合
- `IntersectionObserver`、可见面积与播放状态联合评分
- `MutationObserver` 监听抖音动态新增、移除和复用的视频节点
- 作品 ID 优先、媒体 URL SHA-256 次之的稳定 `videoKey`
- 本地测试 MP3 的播放、暂停、跳转、倍速和切视频控制
- 原视频音量状态保存与可靠恢复
- 播放失败时恢复原声，不阻断用户继续看视频
- 页面 Debug 面板和统一模块日志
- 视频切换异步竞态保护，避免旧音轨影响新视频
- FastAPI 健康检查、媒体任务创建与查询
- 面向 Chrome 扩展的可配置 CORS 和静态音频服务
- 后端请求校验、任务隔离与自动化测试
- 当前视频媒体来源 Strategy、任务提交和状态轮询
- HTTPS 媒体安全下载、SSRF 防护和逐跳重定向校验
- FFmpeg 本地音频提取与 WAV 格式复验
- 相同视频任务原子去重和旧视频异步结果隔离

## 目录

```text
.
├─ README.md
├─ backend/
│  ├─ app/
│  │  ├─ api/
│  │  ├─ schemas/
│  │  ├─ services/
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
   │  │  ├─ debugPanel.ts
   │  │  ├─ dubPlayer.ts
   │  │  ├─ index.ts
   │  │  ├─ videoProcessingCoordinator.ts
   │  │  ├─ videoAudioController.ts
   │  │  ├─ videoDetector.ts
   │  │  ├─ videoKey.ts
   │  │  └─ videoObserver.ts
   │  ├─ popup/
   │  ├─ services/
   │  ├─ types/
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
6. 点击 Chrome 工具栏中的 Douyin English 图标，开启 English Mode。

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

## Phase 1–3 手动验收

建议先在 Popup 中开启 Debug Mode。页面右上角会显示当前 `videoKey`、状态、视频时间、测试音轨时间和同步偏移。

1. 打开抖音网页版并播放任意视频，Debug 面板应出现有效的当前视频信息。
2. 开启 English Mode，原视频应静音，本地英语测试音频开始播放。
3. 暂停视频，测试音频应同时暂停；继续播放后测试音频继续。
4. 拖动视频进度，测试音频应跳到对应位置。测试 MP3 比视频短时会按音频时长循环映射。
5. 上下滑动切换视频，旧测试音轨应立即停止，新视频接管音频；不得出现旧音轨串音。
6. 关闭 English Mode，当前视频应恢复开启前的静音和音量状态。
7. 若浏览器拒绝测试音频播放，状态显示 `English audio unavailable`，同时恢复原视频声音。

控制台日志统一使用以下前缀，便于定位：

```text
[DouyinEnglish][VideoDetector]
[DouyinEnglish][AudioController]
[DouyinEnglish][DubPlayer]
```

## Phase 5 手动验收

先启动后端，再重新构建并加载扩展。打开 Popup，确认“本地后端已连接”；随后开启 Debug Mode 和 English Mode，在抖音播放一条普通视频。

1. Debug 面板应显示当前 `videoKey`、媒体来源策略和 `PROCESSING` 状态。
2. 任务成功后状态变为 `READY`，并显示可访问的 `/audio/{task_id}/audio.wav` 地址。
3. 打开该地址，确认 WAV 内容来自当前作品，而不是上一条或预加载视频。
4. 连续快速切换视频，旧任务完成后不得覆盖当前视频的状态。
5. 找不到可靠直链、遇到 HLS/DASH、签名失效或后端失败时，应显示来源不可用或 `ERROR`，原视频仍正常播放。

建议结合 Chrome DevTools 的 Network 面板验证至少 10 条普通视频：页面实际请求的资源、Debug 面板选中的 URL 和生成的 WAV 必须属于同一作品。Phase 5 只生成标准化 WAV，尚不会把它当作英文配音播放。

## 开发命令

```powershell
npm run typecheck       # TypeScript 静态检查
npm test                # Vitest 单元测试
npm run test:watch      # 测试监听模式
npm run build           # 生成 Chrome 可加载的 dist
npm run generate:audio  # 用 Windows 系统英语语音重新生成测试 MP3
```

仓库已经包含生成好的 `public/audio/test.mp3`，普通开发和构建不需要执行 `generate:audio`。重新生成音频仅支持带有 `System.Speech` 的 Windows 环境，不会调用在线 TTS 服务，也不需要 API Key。

## 实现边界与已知限制

播放器当前使用的音频仍是用于验证同步控制的循环测试素材，不是视频内容的翻译。Phase 5 新生成的 WAV 只用于后续 ASR 输入和独立验收，不会替换 Phase 3 的测试音轨，也不需要任何 AI API Key。

抖音页面结构和 CDN 策略会持续变化。检测逻辑不依赖某个固定 CSS class，但真实页面仍可能出现全屏播放器、直播、广告、特殊卡片、`blob:`、HLS/DASH、过期签名或需要登录态的媒体地址。`blob:` 的 Performance Resource 适配器已隔离保留，但默认禁用，直到能建立与当前视频的可靠因果绑定。实现会在来源不确定时拒绝猜测；不会导出 Cookie、绕过 DRM 或让 FFmpeg 访问远程清单。

下一阶段是 **Phase 6 ASR**：把 Phase 5 生成的 WAV 交给可替换的 ASR Provider，并得到包含 `start`、`end` 和中文 `text` 的时间戳分段。在真实 Chrome 完成 Phase 5 人工验收前，不进入 Phase 6。
