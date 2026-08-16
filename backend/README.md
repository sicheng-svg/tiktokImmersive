# Douyin English Backend — Phase 5

这是 MVP Phase 5 的媒体提取后端。`POST /api/videos/process` 创建后台任务，服务安全下载扩展提交的直链媒体，再调用 FFmpeg 生成单声道、16 kHz、16-bit PCM WAV。该阶段不包含 ASR、翻译或 TTS。

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
- `POST /api/videos/process`：创建媒体提取任务，返回 `202` 和 `task_id`；相同 `video_key + video_url` 会复用未失败任务
- `GET /api/tasks/{task_id}`：查询 `PROCESSING`、`READY` 或 `ERROR`
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

成功时，任务响应的 `audio_url` 指向生成的文件；失败时，`error` 返回不包含内部路径和 FFmpeg stderr 的简化错误。文件按 `task_id` 隔离，`video_key` 不参与本地路径构造。

同一 `video_key` 和规范化后的同一 URL 在 `PROCESSING` 或 `READY` 状态下会原子复用任务，避免并发请求重复下载；原任务进入 `ERROR`，或相同 `video_key` 提交了不同 URL 时，会创建新任务。

## 媒体安全边界

下载器默认只接受白名单域名的 `HTTPS:443`：

- 每次请求和每次重定向都会重新校验域名、DNS 结果和连接对端。
- DNS 解析出的所有地址必须是公网地址；请求固定连接到已校验 IP，同时保留原始 Host 和 TLS SNI。
- HTTP 客户端忽略系统代理环境变量，防止代理绕过本地校验。
- 下载有域名白名单、重定向次数、连接/读取/整体时限和字节上限。
- HTML、JSON、HLS、DASH、ffconcat 和空响应会被拒绝；并发执行数和待处理任务数有上限。
- FFmpeg 不通过 shell 启动，只允许本地 `file,pipe` 协议，并显式禁用网络协议、限制进程时长、最多提取 15 分钟且限制 WAV 为 32 MiB。输出后再次验证 WAV 声道、采样率、位宽和非空帧。
- 写接口还会执行 Origin 校验，Host 头由 TrustedHost 白名单限制。

相关限制均可在 `.env.example` 中查看和调整。扩大媒体域名白名单前，应先确认域名所有权和实际 CDN 跳转链，不要使用过宽的公共后缀。

## 测试

```powershell
.\.venv\Scripts\python.exe -m pytest
.\.venv\Scripts\python.exe -m pip check
```

测试中的网络响应、DNS 和 FFmpeg 都使用 fake/mock，不访问真实外网，也不要求测试机安装 FFmpeg。覆盖任务状态推进、静态音频、SSRF 地址拒绝、重定向逐跳校验、连接对端校验、大小和时限、内容类型、FFmpeg 命令与 WAV 格式、并发容量、Origin 及 TrustedHost。

当前任务数据仍保存在进程内存中，服务重启后任务元数据会丢失；生成的 WAV 不会自动清理。这两项属于后续持久化和生命周期管理范围。

扩展当前只自动提交视频元素明确暴露的 HTTPS 直链。`blob:` 与全页面 Resource Timing 之间没有可靠归属关系，因此默认安全降级，不会为了提高命中率猜测预加载资源。
