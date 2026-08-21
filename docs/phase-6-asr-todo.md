# Phase 6：ASR、上下文翻译与双语字幕 Todo List

状态：Provider-neutral 架构已实现，真实 Provider / 完整构建 / Chrome E2E 待验收  
前置条件：Phase 5.1 已通过真实 Chrome 人工验收（2026-08-18 已确认）  
目标版本：`0.3.0`

本轮实现口径（2026-08-18）：`[x]` 表示已由 Fake/自动化验证的架构项；`[ ]` 表示必须等待真实 Provider、凭证、外部网络、完整扩展构建或真实 Chrome 才能关闭的门禁。当前未配置或调用任何真实 AI 服务，未提交、未推送。

## 阶段目标

把 Phase 5.1 生成的标准 WAV 转成可与当前视频同步显示的中英双语字幕：

```text
audio.wav
↓
中文 ASR
↓
transcript
↓
基于完整上下文的中文 → 英文翻译
↓
bilingual subtitles
↓
Chrome 字幕 Overlay
```

Phase 6 的用户价值是建立一条可独立使用的降级链路：

```text
原中文视频正常播放
→ 中文字幕可用
→ 中英双语字幕可用
→ 后续阶段再增加英文语音
```

任何媒体、ASR 或翻译错误都不得影响原视频播放。Phase 6 正常用户链路保留原中文声音，不静音原视频，也不播放无关的 `test.mp3`。

Phase 6 完成时，每个成功任务至少返回：

```json
{
  "transcript": [
    {
      "segment_id": "s000001",
      "start": 0.0,
      "end": 2.8,
      "text": "今天带大家去看一个地方"
    }
  ],
  "subtitles": [
    {
      "segment_id": "s000001",
      "start": 0.0,
      "end": 2.8,
      "zh": "今天带大家去看一个地方",
      "en": "Today, I'm taking you somewhere special."
    }
  ],
  "segments": []
}
```

字段边界：

- `transcript` 保存规范化后的中文 ASR 分段，不写入英文。
- `subtitles` 保存 Overlay 使用的中英双语字幕，不包含音频地址。
- `segments` 继续保留给后续英文 TTS/配音，不在 Phase 6 提前复用。
- `audio_url` 仍指向 Phase 5 生成的中文 WAV，不代表英文配音地址。

## Definition of Done

- [ ] 真实 `audio.wav` 可以生成非空中文 transcript。
- [x] 每个 transcript 分段包含合法且稳定的 `segment_id`、`start`、`end`、`text`。
- [x] 时间戳单调、有界，并与音频时长基本一致。
- [x] 本地 Translation Provider facade 接收完整有序中文上下文，并返回与输入严格一一对应的英文；远端调用允许使用版本化分块策略。
- [x] 每个完整双语字幕分段包含合法的 `segment_id`、`start`、`end`、`zh`、`en`。
- [x] `GET /api/tasks/{task_id}` 可以返回 stage、步骤状态、transcript 和 subtitles。
- [x] `POST /api/videos/process` 复用 READY 任务时返回完整任务结果。
- [x] transcript 与 translation 使用独立、版本化、原子写入的缓存。
- [x] 同一音频和同一 transcript 重复处理分别命中缓存，不重复调用 Provider；当前由计数 Fake 验证，真实 Provider 仍需 E2E 复核。
- [x] ASR 与 Translation Provider 均可替换，业务流水线不引用具体厂商 SDK。
- [x] Key 和代理凭证只从环境变量读取，不进入代码、日志、响应、缓存或 Git。
- [x] 翻译失败时保留中文 transcript，双语模式降级显示中文字幕。
- [x] ASR 失败时不显示伪造字幕，原视频仍可正常播放。
- [x] 正式 Overlay 支持“中英双语 / 仅英文 / 关闭”。
- [x] 快速切换视频时旧任务结果不得覆盖当前视频字幕。
- [x] Phase 6 正常链路不加载 `test.mp3`，不修改原视频 `muted` 或 `volume`。
- [ ] 自动化测试、真实短视频 Chrome 验收和 README 均完成。

## 0. Provider 与数据边界决策门

- [ ] 选择一个支持中文分段时间戳的真实 ASR Provider 和模型。
- [ ] 选择一个支持完整上下文、`zh → en` 和结构化一一对应输出的真实 Translation Provider 和模型/API 版本。
- [ ] ASR 和 Translation Provider 分别配置；即使来自同一厂商，也不得在领域接口中耦合。
- [ ] 用同一个 10～30 秒中文口播 WAV 对 ASR 做 smoke test。
- [ ] 用该 WAV 的完整 transcript 对翻译做 smoke test，检查专名、代词、数字、口语和跨段上下文一致性。
- [ ] 记录准确度、分段粒度、英文质量、响应时延、限制、网络可达性和调用成本。
- [ ] 确认开发环境直连或使用独立显式代理；不得复用媒体下载器的 SSRF 通道。
- [ ] 确认 ASR 明确使用中文，翻译明确使用 `zh → en`，不做无意义的语言自动检测。
- [ ] 明确数据上传边界：ASR 只收到 WAV；翻译只收到规范化 transcript 文本。
- [ ] 不向 Provider 上传媒体签名 URL、Cookie、页面 DOM、标题、评论或身份信息。

决策原则：MVP 每种能力只维护一个真实 Provider，但代码层保留独立替换接口。开发和自动化测试使用 Fake Provider；Fake 结果不得冒充真实验收。

## 1. 领域模型与 Provider 接口

- [x] 新增 `TranscriptSegment`：`segment_id`、`start`、`end`、`text`。
- [x] 新增 `TranscriptResult`：语言、音频时长、segments 和安全的 Provider 元数据。
- [x] 新增 `TranslationInputSegment`：`segment_id`、`text`。
- [x] 新增 `TranslationUnit`：`segment_id`、英文 `text`。
- [x] 新增 `TranslationResult`：源语言、目标语言、units、Provider 元数据和翻译策略版本。
- [x] 新增 `SubtitleSegment`：`segment_id`、`start`、`end`、`zh`、`en`。
- [x] `segment_id` 由本地规范化流程按稳定顺序生成，Provider 只能回显本地 ID，不得自行生成或替换。
- [x] 定义 `ASRProvider` Protocol，只接收本地 WAV 路径，不允许自行下载 URL。
- [x] 定义 `TranslationProvider` Protocol，接收完整有序 transcript；Adapter 可在内部按版本化策略分块，但只返回对应英文。
- [x] 翻译 Provider 不得提供或修改时间戳、中文原文和分段顺序。
- [x] 分别定义稳定异常：鉴权失败、超时、限流、无语音、响应非法、服务不可用和内容超限。
- [x] 实现确定性的 `FakeASRProvider` 和 `FakeTranslationProvider`。
- [ ] 分别实现一个真实 Adapter，并通过工厂按配置注入。
- [x] 禁止业务流水线直接 import 具体厂商客户端。

建议接口：

```python
class ASRProvider(Protocol):
    def transcribe(self, audio_path: Path) -> TranscriptResult: ...

class TranslationProvider(Protocol):
    def translate(
        self,
        segments: tuple[TranslationInputSegment, ...],
    ) -> TranslationResult: ...
```

## 2. 配置、网络与密钥安全

- [ ] 增加 `DOUYIN_ENGLISH_ASR_PROVIDER`、模型、语言、超时、重试和输入限制配置。
- [ ] 增加 `DOUYIN_ENGLISH_TRANSLATION_PROVIDER`、模型/API 版本、源/目标语言、超时、重试和输入输出限制配置。
- [ ] ASR 与翻译分别支持可选的显式代理配置，默认不继承系统代理。
- [ ] `.env.example` 只放空占位符，不放真实 Key、代理凭证或可用 Token。
- [ ] 开发/测试显式选择 Fake；选择真实 Provider 时缺少必需配置应启动失败并给出明确错误。
- [ ] 日志只记录 task ID、stage、Provider、耗时、segment 数量、cache hit/miss 和稳定错误类别。
- [ ] 日志不记录 Key、代理 URL、完整 transcript、完整英文翻译或 Provider 原始响应。
- [ ] ASR 和翻译分别设置连接、读取、写入和整体超时。
- [ ] 只对网络错误、限流和服务端错误进行有限重试；鉴权、无语音和非法响应不重试。
- [ ] 限制 ASR WAV 大小与时长，并限制翻译的 segment 数、单段字符数、总字符数和响应体大小。
- [ ] 服务关闭时对两种网络调用都使用有限等待，不允许无限 shutdown。

## 3. Transcript 校验与规范化

- [ ] 拒绝 `NaN`、无穷值、负时间和 `end <= start`。
- [ ] 拒绝空文本、超长文本、控制字符和超量 segments。
- [ ] 校验时间戳单调，不允许严重倒序或越过音频时长。
- [ ] 允许小范围时间戳重叠，但设置明确容差并测试。
- [ ] 清理首尾空白和不可见控制字符，不改写中文语义。
- [ ] 为规范化分段生成稳定、连续的本地 `segment_id`，并拒绝采信 Provider 自行提供的身份。
- [ ] Phase 6 保持确定性一一对应，不做 TTS 专用语义重分段。
- [ ] Provider 返回“无可识别语音”时使用独立错误，不伪造空 READY。

## 4. 上下文翻译与双语字幕校验

- [ ] Translation Provider facade 始终接收完整有序 transcript，不按单段发起互不相关的翻译任务。
- [ ] 普通逐条机器翻译 API 只有在 Adapter 能证明跨段上下文和稳定结构映射时才可选；否则使用支持结构化输出的上下文文本模型。
- [ ] 长 transcript 的远端请求可使用确定性分块；当前块获得必要前后文并维护跨块术语上下文，但只输出当前块的 `segment_id`。
- [ ] 分块策略、上下文窗口和翻译提示均版本化。
- [ ] transcript 内容视为不可信数据，不得把口播中的指令当作系统指令执行。
- [ ] 默认翻译风格：忠实、自然、简洁、适合字幕；不总结、不解释、不扩写、不新增事实。
- [ ] 保留人名、地名、品牌、数字、单位、语气和跨段术语一致性。
- [ ] 翻译结果的 ID 集合、数量和顺序必须与输入完全一致。
- [ ] 拒绝重复、遗漏、额外或乱序 ID。
- [ ] 拒绝空英文、超长英文、控制字符、HTML 注入和畸形结构。
- [ ] 最终 `start`、`end`、`zh` 只取自本地 transcript；只采信 Provider 返回的英文文本。
- [ ] 任一翻译单元失败时整批双语结果不发布、不缓存，不拼接部分英文。
- [ ] Overlay 使用文本节点渲染翻译结果，禁止把 Provider 文本写入 `innerHTML`。

## 5. 分层缓存

- [ ] 新增独立 `ASRCache` 与 `TranslationCache` 接口和文件实现。
- [ ] ASR 缓存键包含 WAV SHA-256、Provider、模型、语言、时间戳粒度和 schema/validator version。
- [ ] Translation 缓存键包含规范化 `{segment_id, text}` 摘要、Provider、模型/API 版本、`zh → en`、提示版本、分块策略版本和 schema/validator version。
- [ ] 翻译缓存不依赖时间戳，只保存合法的 `segment_id → en`，命中后与当前 transcript 本地合并。
- [ ] 缓存目录使用固定摘要，不直接把 `videoKey` 当作 Windows 路径。
- [ ] 两层缓存均采用同目录临时文件加原子替换。
- [ ] 缓存损坏、版本不兼容或校验失败时只使当前层失效。
- [ ] ASR 命中而 Translation 未命中时只调用翻译；Translation 损坏不得导致重复 ASR。
- [ ] 两层缓存分别实现进程内 single-flight，同一键最多执行一次真实调用。
- [ ] 缓存不保存 API Key、代理、task ID、`videoKey`、签名 URL、页面信息、原始响应或异常堆栈。

建议目录：

```text
backend/cache/
├── asr/{asr_cache_key}/transcript.json
└── translation/{translation_cache_key}/translation.json
```

## 6. 后端流水线、状态与降级

- [ ] 保持顶层 `PROCESSING / READY / ERROR` 兼容。
- [ ] 新增 `TaskStage`：`FETCHING / EXTRACTING / TRANSCRIBING / TRANSLATING / READY`。
- [ ] `TaskStage` 不再使用笼统的 `ERROR`；失败时顶层状态为 `ERROR`，stage 保留实际失败阶段。
- [ ] 明确进度区间，progress 只能单调增加。
- [ ] FFmpeg 成功后调用 ASR，ASR 成功后原子发布 transcript 并进入 `TRANSLATING`。
- [ ] 翻译与双语字幕校验、落盘全部成功后，任务才进入 `READY`。
- [ ] 下载失败：`status=ERROR`、`stage=FETCHING`、transcript/subtitles 均为空。
- [ ] FFmpeg 失败：`status=ERROR`、`stage=EXTRACTING`、transcript/subtitles 均为空。
- [ ] ASR 失败：`status=ERROR`、`stage=TRANSCRIBING`、transcript/subtitles 均为空。
- [ ] 翻译失败：`status=ERROR`、`stage=TRANSLATING`、保留 transcript、subtitles 为空。
- [ ] 扩展在翻译失败时可用 transcript 降级显示中文字幕，但不得把该任务伪装成完整双语 READY。
- [ ] 公开错误只使用稳定安全文案，不包含 Provider 原始响应、完整文本或内部路径。
- [ ] 用户切换视频后旧任务可以完成并写入两层缓存，但不得覆盖当前视频状态或 Overlay。
- [ ] 服务关闭时有限等待，随后取消未开始工作并关闭两种 Provider Client。

建议进度：

```text
5    下载开始
40   媒体下载完成
60   WAV 提取完成
65   ASR 开始
80   transcript 校验并写入 ASR cache
85   上下文翻译开始
95   双语字幕校验并写入 Translation cache
100  READY
```

## 7. API 契约

- [ ] 新增 `TaskStage` schema。
- [ ] `TaskResponse` 新增 `transcript: list[TranscriptSegment]`。
- [ ] `TaskResponse` 新增 `subtitles: list[SubtitleSegment]`。
- [ ] 保留现有 `segments` 字段给后续英文 TTS/配音，Phase 6 始终不填充音频片段。
- [ ] 新增必需的 `steps.asr` 与 `steps.translation`，步骤状态固定为 `PENDING / PROCESSING / READY / ERROR / SKIPPED`。
- [ ] 每个步骤返回 `cache_hit: bool | null`；尚未执行或失败前未知时为 `null`，不得把 task 复用伪装成 cache hit。
- [ ] ASR 失败时 `steps.asr=ERROR`、`steps.translation=SKIPPED`；翻译失败时 `steps.asr=READY`、`steps.translation=ERROR`。
- [ ] 步骤状态不得暴露 Provider 原始元数据、完整提示或正文。
- [ ] `TRANSCRIBING` 时 transcript/subtitles 均为空。
- [ ] `TRANSLATING` 时 transcript 非空、subtitles 为空。
- [ ] `READY` 时 transcript/subtitles 均非空，ID、数量、顺序、时间戳和中文严格一一对应。
- [ ] 翻译失败时 transcript 非空、subtitles 为空，并返回安全错误与 `stage=TRANSLATING`。
- [ ] 下载或 FFmpeg 失败时 transcript/subtitles 均为空，stage 分别为 `FETCHING` 或 `EXTRACTING`。
- [ ] `POST /api/videos/process` 继续返回 `202`，但返回完整 `TaskResponse`，避免复用 READY 任务时丢失字幕。
- [ ] POST 响应额外返回 `task_reused: bool`；它只表示内存 TaskStore 复用，不得与两层 `cache_hit` 混淆。
- [ ] OpenAPI 明确字段语义、阶段不变量、降级结果和错误响应。
- [ ] 老的 Phase 5 客户端忽略新增字段时仍能正常工作。
- [ ] 新扩展收到同时缺少 stage、transcript、subtitles 的旧后端 READY 响应时，只识别为 legacy media-ready，不显示 Overlay，并提示后端需要升级。
- [ ] 新响应只要部分缺少或包含非法的新字段就整批拒绝，不得按 legacy 响应静默接受。
- [ ] 更新 API round-trip、404、422、复用 READY、并发去重和 app 隔离测试。

## 8. 扩展字幕 Overlay 与用户体验

- [ ] Service Worker 严格校验并映射 stage、transcript 和 subtitles，同时兼容旧后端缺少新字段。
- [ ] Content Coordinator 保持 generation、video element、`videoKey` 和作品绑定隔离。
- [ ] 新增独立 `SubtitleOverlay`，不把正式字幕塞入 Debug Panel。
- [ ] Overlay 使用 Shadow DOM 或等价隔离，避免受抖音页面 CSS 污染。
- [ ] Overlay 跟随当前视频矩形、滚动、resize、竖屏布局和 fullscreen 变化。
- [ ] Overlay 使用 `pointer-events: none`，不得遮挡视频控制或页面操作。
- [ ] 使用 `video.currentTime` 选择 `start <= currentTime < end` 的字幕；seek、pause、ended、emptied 时立即刷新。
- [ ] 播放期间优先用 `requestVideoFrameCallback` 持续更新时间；不可用时用 `timeupdate` 加有界定时器回退。
- [ ] 多个重叠 cue 同时命中时选择 `start` 最晚的片段；切视频、stop 和 pagehide 时取消所有帧回调与定时器。
- [ ] 支持“中英双语 / 仅英文 / 关闭”，切换显示模式不得重新提交任务或调用 Provider。
- [ ] 双语模式默认英文主行、中文副行；翻译失败时降级显示中文。
- [ ] 仅英文模式在翻译失败时不显示错误语言字幕，并给出安全状态提示。
- [ ] `off` 立即清空 Overlay；已提交的后端任务可继续完成并写缓存。
- [ ] Popup 总开关关闭时同步清空 Overlay、停止新提交和客户端轮询；已提交后端任务仍可完成并写缓存。
- [ ] Popup 总开关只控制字幕处理与展示，不再启停 `DubPlayer` 或修改原视频音量。
- [ ] 切换视频、DOM 节点复用、页面退出或 coordinator stop 时同步清空旧字幕。
- [ ] Debug 面板只显示 stage、transcript/subtitle 数量、cache 状态和安全错误，不显示完整正文。
- [ ] Popup 状态文案支持“正在识别中文”“正在翻译英文”“双语字幕就绪”和“已降级为中文字幕”。
- [ ] Popup 总开关文案从纯“英文配音”调整为当前真实能力；英文语速控件在 TTS 前隐藏、禁用或标记为暂不可用。
- [ ] Phase 6 正常用户链路不得加载或播放 `test.mp3`，不得修改原视频 `muted`、`volume` 或播放速度。
- [ ] 保留 `DubPlayer`、测试音频资产和播放器控制测试，供后续英文语音阶段复用。

## 9. 自动化测试

- [ ] ASR Provider contract：正常、多段、无语音、超时、限流、鉴权失败和畸形响应。
- [ ] Translation Provider contract：正常、多段、上下文一致、遗漏/重复/乱序/额外 ID、空英文、超长输出和畸形结构。
- [ ] Transcript validator：边界时间、倒序、重叠、越界、空文本、控制字符和超量片段。
- [ ] Translation validator：严格一一对应，Provider 不得修改中文、时间戳或分段。
- [ ] Context batching：分块边界、前后文传递、只返回当前块和策略版本变化。
- [ ] Pipeline：下载 → FFmpeg → Fake ASR → Fake Translation → READY。
- [ ] Failure：ASR 错误无 transcript；翻译错误保留 transcript、无部分 subtitles。
- [ ] ASR cache：首次调用、命中、损坏恢复、schema 升级和并发 single-flight。
- [ ] Translation cache：首次调用、命中、模型/语言/提示/策略变更失效、损坏后只重做翻译和并发 single-flight。
- [ ] API：stage、progress、transcript、subtitles、复用 READY 完整响应和向后兼容。
- [ ] Extension Gateway：新字段映射、旧响应兼容和畸形字段拒绝。
- [ ] Coordinator：`TRANSCRIBING → TRANSLATING → READY`、中文降级和旧视频异步结果隔离。
- [ ] Overlay：双语/英文/off、连续播放、边界时间、空档、重叠裁决、seek、pause、ended、切视频、resize 和 fullscreen。
- [ ] Popup 总开关：关闭后不提交、不轮询、不恢复迟到 Overlay，且不触发 `DubPlayer`。
- [ ] Overlay 安全：HTML/script 字符串只按文本显示。
- [ ] 音频回归：字幕开启后原视频音量不变，且不调用 `DubPlayer.load()` 或 `play()`。
- [ ] 有界 shutdown 和未开始任务取消。
- [ ] 完整后端测试、扩展 typecheck/test/build、`pip check` 和 `git diff --check` 全部通过。

## 10. 真实 Chrome E2E 验收

- [ ] 使用 3～5 条 10～60 秒、中文清晰口播的抖音视频。
- [ ] Debug 面板可以看到 `TRANSCRIBING → TRANSLATING → READY`。
- [ ] 每个成功任务返回至少一个 transcript 和一个对应 subtitle segment。
- [ ] 人工抽查中文文本与视频语音基本一致。
- [ ] 人工抽查英文忠实、自然、简洁，没有总结、解释或新增事实。
- [ ] 跨片段的人名、代词、数字和术语保持一致，证明翻译使用了上下文。
- [ ] 双语、仅英文、关闭三种模式即时生效，切换模式不产生新 Provider 调用。
- [ ] 播放、暂停、前后 seek、字幕空档和视频倍速时字幕保持同步。
- [ ] 快速切换两条视频，旧字幕立即消失且不得恢复或覆盖新视频。
- [ ] 普通页面、竖屏视频、滚动和真实 fullscreen 下位置可读且不遮挡交互。
- [ ] 原视频音量和静音状态全程不变，正常链路不请求 `test.mp3`。
- [ ] 保留磁盘缓存并重启后端以清空内存 TaskStore，再提交同一内容，验证真实命中 ASR 与 Translation cache。
- [ ] 缓存验收分别记录 `task_reused`、`asr_cache_hit` 和 `translation_cache_hit`，不得把 READY task 复用当作缓存命中。
- [ ] 翻译断网或 Key 无效验收使用未缓存 transcript 或独立空缓存目录；双语模式降级显示中文，原视频继续播放。
- [ ] ASR 断网、无语音或 Key 无效验收使用未缓存 WAV 或独立空缓存目录；不显示伪造字幕，原视频继续播放。
- [ ] 记录任务 ID、两类 segment 数量、处理耗时、缓存命中和安全截图。
- [ ] 验收记录不得包含签名 URL、Key、代理凭证或完整 transcript。

## 11. 文档与版本收尾

- [ ] 后端和扩展版本升级到 `0.3.0`。
- [ ] 更新根 README、backend README、`.env.example` 和本地启动步骤。
- [ ] 写清 ASR 的音频上传边界、翻译的文本上传边界、费用风险和网络要求。
- [ ] 写清三种字幕模式、中文降级行为和正常链路保留原声。
- [ ] 写清 Phase 6 的 `audio_url` 不是英文配音，`segments` 仍为空。
- [ ] 记录真实验收任务 ID、segment 数量、处理耗时和两层缓存命中证据。
- [ ] 自动化和真实验收通过后，再单独确认是否创建 `feat` 提交并推送。

## 明确不在 Phase 6 实现

- [ ] 不做英文 TTS 或真实英文语音生成。
- [ ] 不播放、替换或缓存真实英文配音。
- [ ] 不做声音复刻、口音迁移或声音克隆。
- [ ] 不做人声/BGM 分离或最终音轨混音。
- [ ] 不启用英文语速控制。
- [ ] 不为 TTS 改写或重新切分已经交付的字幕文本和时间轴。
- [ ] 不做说话人识别、多人声轨或声纹。
- [ ] 不做预加载队列和多视频 AI 并发调度。
- [ ] 不新增登录、支付、云端任务数据库或浏览器商店发布。

后续英文语音应通过独立 endpoint/job 消费 `subtitles`，拥有独立 Provider、缓存和 `SYNTHESIZING` 状态。TTS 可以生成自己的 `DubSegment` 和 `speech_text`，但不得反向修改 Phase 6 已交付的字幕。英文语音失败时自动退回“原中文音频 + 双语字幕”。

## 当前卡脖子问题

1. 尚未最终确定真实 ASR Provider、模型、凭证和网络路径。
2. 尚未最终确定真实 Translation Provider、模型/API 版本、凭证和翻译费用。
3. 国内网络访问、代理稳定性和两种 Provider 的超时必须通过真实 smoke test 验证。
4. 不同 ASR Provider 的时间戳粒度差异需要统一 validator 隔离。
5. 上下文翻译必须兼顾完整语义与稳定的一一对应，不能让模型任意合并、拆分或改时间戳。
6. 抖音页面布局、竖屏和 fullscreen 会影响 Overlay 定位，必须用真实 Chrome 验证。
7. 长视频继续受媒体下载、WAV 大小和最长 15 分钟限制；Phase 6 不绕过现有安全边界。

## 推荐执行顺序

```text
ASR + Translation Provider 双 smoke test
→ 两套 Provider Protocol 与 Fake 实现
→ Transcript / Translation / Subtitle schema 与 validator
→ ASR cache
→ Translation cache
→ MediaTaskProcessor 与 TRANSLATING 阶段
→ API transcript + subtitles 契约
→ 扩展解除 mock 配音绑定
→ 正式 Subtitle Overlay 与三种显示模式
→ 自动化全量回归
→ 真实 Chrome 双语字幕 E2E
→ README 与 0.3.0 收尾
→ 单独确认 commit / push
```
