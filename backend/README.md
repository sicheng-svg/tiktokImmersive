# Douyin English Backend — Phase 4

这是 MVP Phase 4 的 FastAPI 骨架。当前后端只验证 HTTP 边界、任务状态保存和静态音频访问，不下载视频、不执行 FFmpeg，也不调用 ASR、翻译或 TTS。

## 环境

- Python 3.11 或更高版本
- Windows PowerShell

## 安装

```powershell
cd D:\code\codex\tiktok\backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
Copy-Item .env.example .env
```

如果 `python` 不在 `PATH` 中，请把第一条命令中的 `python` 替换为本机 Python 3.11+ 可执行文件的完整路径。

## 启动

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --env-file .env
```

服务默认运行在 `http://127.0.0.1:8000`：

- `GET /health`：健康检查
- `POST /api/videos/process`：创建模拟处理任务
- `GET /api/tasks/{task_id}`：查询模拟任务
- `GET /audio/{filename}`：访问 `output/audio` 中的静态文件
- `GET /docs`：OpenAPI 调试页面

创建任务示例：

```powershell
$body = @{
    video_key = "7382738211234567890"
    video_url = "https://www.douyin.com/video/7382738211234567890"
} | ConvertTo-Json

$task = Invoke-RestMethod `
    -Method Post `
    -Uri "http://127.0.0.1:8000/api/videos/process" `
    -ContentType "application/json" `
    -Body $body

Invoke-RestMethod "http://127.0.0.1:8000/api/tasks/$($task.task_id)"
```

Phase 4 的任务会一直保持 `PROCESSING`，这是有意设计。真正的媒体下载和状态推进属于 Phase 5。

## 测试

```powershell
.\.venv\Scripts\python.exe -m pytest
```

测试覆盖健康检查、任务创建和查询、输入校验、404、CORS 预检与实际请求、静态音频、相对路径解析、并发任务访问，以及多个应用实例之间的任务隔离。
