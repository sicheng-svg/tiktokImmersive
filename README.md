# Douyin English MVP

这是一个面向 PC Chrome 的抖音网页版英文沉浸式配音实验项目。当前仓库已经完成 MVP 文档中的 **Phase 1–4**：浏览器端播放器控制链路，以及独立的 FastAPI 后端骨架。

当前版本可以安装为 Manifest V3 扩展，识别抖音页面中当前可见且正在播放的视频，在 English Mode 开启时保存并静音原视频音量，同步播放一个本地英语测试 MP3，并在暂停、继续、跳转或切换视频时同步控制测试音轨。关闭插件、切换视频或播放失败时，会恢复对应视频原来的 `muted` 和 `volume` 状态。

后端当前只提供健康检查、模拟任务 API 和静态音频服务。它有意不下载媒体、不调用 FFmpeg，也不执行 ASR、翻译或真实 TTS；这些能力会继续按 MVP Phase 5–8 的顺序逐步接入。

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
- FastAPI 健康检查、模拟任务创建与查询
- 面向 Chrome 扩展的可配置 CORS 和静态音频服务
- 后端请求校验、任务隔离与自动化测试

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
   │  ├─ background/serviceWorker.ts
   │  ├─ content/
   │  │  ├─ debugPanel.ts
   │  │  ├─ dubPlayer.ts
   │  │  ├─ index.ts
   │  │  ├─ videoAudioController.ts
   │  │  ├─ videoDetector.ts
   │  │  ├─ videoKey.ts
   │  │  └─ videoObserver.ts
   │  ├─ popup/
   │  ├─ services/
   │  ├─ types/
   │  └─ utils/
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

需要 Python 3.11 或更高版本。首次安装并启动：

```powershell
cd D:\code\codex\tiktok\backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
Copy-Item .env.example .env
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --env-file .env
```

访问 `http://127.0.0.1:8000/health` 应返回 `{"status":"ok"}`，交互式 API 文档位于 `http://127.0.0.1:8000/docs`。完整接口示例和测试命令见 [backend/README.md](backend/README.md)。

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

当前音频是用于验证播放器控制的循环测试素材，不是视频内容的翻译。Phase 4 后端只保存内存中的模拟任务元数据，不会访问请求里的视频 URL，因此不会下载抖音视频，也不需要任何 API Key。

抖音页面结构会持续变化。检测逻辑不依赖某个固定 CSS class，但真实页面仍可能出现全屏播放器、直播、广告或特殊卡片等边界情况。Debug Mode 和模块日志用于完成 20 条连续切换等人工稳定性验收；这部分必须在实际 Chrome 与真实抖音会话中完成。

下一阶段是 Phase 5 Media Extraction：在扩展端隔离音频来源策略，在后端安全获取单条当前视频媒体并通过 FFmpeg 生成统一的 `mono / 16 kHz / wav` 音频。ASR、Translation 和 TTS Provider 仍要等媒体提取独立验收通过后再实现。
