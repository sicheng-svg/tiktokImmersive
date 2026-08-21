# Douyin English Backend — Phase 6

这是 MVP Phase 6 的字幕后端（版本 `0.3.0`）。`POST /api/videos/process` 创建后台任务，服务安全下载扩展提交的直链媒体，调用 FFmpeg 生成单声道、16 kHz、16-bit PCM WAV，再执行中文 ASR、带完整有序上下文的 `zh → en` 翻译，并返回中英双语字幕。`segments` 继续保留给后续英文 TTS，当前始终为空。

当前仓库只实现了确定性的 Fake ASR/Translation Provider，输出分别带有 `假转写` 和 `[FAKE TRANSLATION]` 标记，只用于本地开发与自动化测试。真实厂商 Adapter、真实准确度/成本 smoke test 尚未完成；将 `DOUYIN_ENGLISH_ASR_PROVIDER` 或 `DOUYIN_ENGLISH_TRANSLATION_PROVIDER` 改为非 `fake` 值会明确拒绝启动，不会把 Fake 伪装成真实服务。Provider 的 Key、独立显式代理、超时和重试字段已经预留在 `.env.example` 中，但 Fake 不访问网络，这些配置不代表真实 Provider 已接通。

## 环境

- Python 3.11 或更高版本
- FFmpeg，可通过 `ffmpeg -version` 验证
- Windows PowerShell

## 安装

```powershell
cd D:\code\codex\tiktok\backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
Copy-Item .env.example .env
```

如果 `python` 不在 `PATH` 中，请把第一条命令中的 `python` 替换为本机 Python 3.11+ 可执行文件的完整路径。安装 FFmpeg 或修改用户 `PATH` 后需要重新打开 PowerShell；FFmpeg 仍不在 `PATH` 时，可在 `.env` 中把 `DOUYIN_ENGLISH_FFMPEG_BINARY` 设置为其绝对路径。

## 启动

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app `
    --host 127.0.0.1 `
    --port 8000 `
    --env-file .env
```

服务应只绑定 `127.0.0.1`。当前 MVP 没有用户认证，不能直接暴露到局域网或公网。默认允许无 `Origin` 的本机 curl/PowerShell 调试请求；浏览器写请求必须来自配置的前端地址或合法 Chrome 扩展 Origin。部署时若不需要命令行调试，可设置 `DOUYIN_ENGLISH_ALLOW_MISSING_ORIGIN=false`。

接口：

- `GET /health`：健康检查
- `POST /api/videos/process`：创建任务，返回 `202`、完整任务快照和必需的 `task_reused`；相同 `video_key + video_url` 会复用未失败任务
- `GET /api/tasks/{task_id}`：查询完整任务快照，不返回仅属于本次 POST 的 `task_reused`
- `GET /audio/{task_id}/audio.wav`：访问成功任务的 WAV 文件
- `GET /docs`：OpenAPI 调试页面

创建任务示例：

```powershell
$body = @{
    video_key = "7382738211234567890"
    video_url = "https://example.douyinvod.com/signed-video-url"
} | ConvertTo-Json

$task = Invoke-RestMethod `
    -Method Post `
    -Uri "http://127.0.0.1:8000/api/videos/process" `
    -ContentType "application/json" `
    -Body $body

Invoke-RestMethod "http://127.0.0.1:8000/api/tasks/$($task.task_id)"
```

任务阶段依次为 `FETCHING / EXTRACTING / TRANSCRIBING / TRANSLATING / READY`，顶层状态保持 `PROCESSING / READY / ERROR`。`steps.asr` 和 `steps.translation` 始终显式存在，步骤状态为 `PENDING / PROCESSING / READY / ERROR / SKIPPED`。`cache_hit=true` 只表示实际使用了合法磁盘缓存，`false` 表示查找未命中后实际调用了 Provider，尚未检查或失败前未知时为 `null`；它与 `task_reused` 无关。

成功时，`audio_url` 指向原中文 WAV，`transcript` 返回规范化中文分段，`subtitles` 返回严格一一对应的中英字幕。ASR 失败时不发布伪造 transcript；翻译失败时任务为 `ERROR/TRANSLATING`，但保留 WAV 和中文 transcript，`subtitles` 为空，客户端可降级显示中文字幕。公开 `error` 不包含内部路径、Provider 原始响应、正文、Key 或代理凭证。

同一 `video_key` 和规范化后的同一 URL 在 `PROCESSING` 或 `READY` 状态下会原子复用任务，避免并发请求重复下载；原任务进入 `ERROR`，或相同 `video_key` 提交了不同 URL 时，会创建新任务。

## 媒体安全边界

下载器默认只接受白名单域名的 `HTTPS:443`：

- 每次请求和每次重定向都会重新校验域名、DNS 结果和连接对端。
- DNS 解析出的所有地址必须是公网地址；请求固定连接到已校验 IP，同时保留原始 Host 和 TLS SNI。
- HTTP 客户端忽略系统代理环境变量，防止代理绕过本地校验。
- CDN 请求使用固定浏览器兼容 `User-Agent`、固定抖音 `Referer` 和最小媒体请求头；不会转发浏览器 Cookie、Authorization 或任意页面请求头。
- 下载有域名白名单、重定向次数、连接/读取/整体时限和字节上限。
- HTML、JSON、HLS、DASH、ffconcat 和空响应会被拒绝；并发执行数和待处理任务数有上限。
- FFmpeg 不通过 shell 启动，只允许本地 `file,pipe` 协议，并显式禁用网络协议、限制进程时长、最多提取 15 分钟且限制 WAV 为 32 MiB。输出后再次验证 WAV 声道、采样率、位宽和非空帧。
- 写接口还会执行 Origin 校验，Host 头由 TrustedHost 白名单限制。
- CDN 拒绝会记录域名、HTTP 状态和重定向次数，但不会记录 URL 路径、查询参数、签名或响应正文。

相关限制均可在 `.env.example` 中查看和调整。扩大媒体域名白名单前，应先确认域名所有权和实际 CDN 跳转链，不要使用过宽的公共后缀。

## 测试

```powershell
.\.venv\Scripts\python.exe -m pytest
.\.venv\Scripts\python.exe -m pip check
```

测试中的网络响应、DNS、FFmpeg 和语言 Provider 都使用 fake/mock，不访问真实外网，也不要求测试机安装 FFmpeg。覆盖状态不变量、失败降级、READY 任务复用、严格 transcript/translation 校验、缓存损坏恢复、两层 single-flight、静态音频、SSRF 地址拒绝、重定向逐跳校验、连接对端校验、大小和时限、内容类型、FFmpeg 命令与 WAV 格式、有界关闭、并发容量、Origin 及 TrustedHost。

当前任务数据仍保存在进程内存中，服务重启后任务元数据会丢失；ASR 与 Translation 缓存分别原子写入 `backend/cache/asr` 和 `backend/cache/translation`，生成的 WAV 和缓存不会自动清理。任务持久化与生命周期清理属于后续范围。

扩展会自动提交视频元素明确暴露的 HTTPS 直链。对 `blob:` 视频，Phase 5.1 只使用由抖音 aweme/feed 响应捕获、并与当前 DOM 作品 ID 和 `videoKey` 精确一致的媒体地址；全页面 Resource Timing 猜测仍默认禁用。一个作品响应中的多个合法 CDN 地址会按顺序保留，只有首选地址出现明确下载类错误时才会尝试备用地址。
