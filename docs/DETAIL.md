# 模型请求落盘（llm-trace）

开关打开后，这个插件把每次模型调用的**输入**和**请求明细**写到指定目录。目的是：当网关以内容审核为由中断请求（例如 `<400> InternalError.Algo.DataInspectionFailed`）时，不用再反推模型当时收到了什么。

## 打开与关闭

- 打开：**设置 → 通用 → 模型请求落盘**，把开关拨到开。
- 开关是「volatile」配置项：拨动后立即生效，不需要重启插件，也不会重启 DSH。
- 默认是关闭状态。

## 落盘位置

默认 `~/.dsh/traces/llm`，可在插件配置里改 `outputDir`。

```
<outputDir>/
├── index.jsonl                     每次落盘的摘要，一行一个 case
└── cases/
    └── 20261111-154131_qwen4-max-preview_t6-s6_a1/
        ├── meta.json               主键、时间、用量、错误码
        ├── request.json            逻辑请求：messages / tools / controls
        ├── request.txt             同一份请求的可读渲染，可 grep
        ├── wire.request.json       线上原始请求体与请求头（密钥已打码）
        ├── wire.headers.json       响应头、HTTP 状态、x-request-id
        ├── wire.response.txt       非 2xx 的响应原文（审核报错正文）
        ├── chunks.jsonl            原始流式 chunk（默认关闭）
        └── prev/                   落盘前几次成功调用的快照，用于对照
```

## 三种采集模式

| 模式 | 行为 |
|---|---|
| `on-failure`（默认） | 只有调用失败（error / aborted / 异常）才落盘，并附带此前 `ringSnapshots` 次成功调用做对照。日常开启几乎不占磁盘。 |
| `moderation` | 更窄：只落带审核特征（`failurePatterns`）或 HTTP ≥ 400 的失败。 |
| `always` | 每次调用都落盘。排查期短期使用。 |

## 读取

在对话里让 agent 调用 `llm_trace` 工具：

- `llm_trace status`：开关、目录、已用空间、最近 case。
- `llm_trace list`：最近若干次落盘记录。
- `llm_trace show latest`：某个 case 的概要、错误原文、最大的几条消息。
- `llm_trace grep "词" latest`：在某个 case 的 `request.txt` 里定位这个词出现在第几条消息。

## 限制与注意事项

- **敏感内容**：开启后磁盘上会保存完整的提示词、工具结果与代码片段。这也是它有用的原因；请把落盘目录当作敏感目录对待。密钥类字符串按 `redactPatterns` 打码，`authorization` 等请求头按 `redactHeaders` 打码。
- **覆盖范围**：捕捉的是走 Host `globalThis.fetch` 的出网请求，以及经过 `ctx.llm.stream` 的模型调用。其他进程、内嵌浏览器、以及不经过 fetch 的 SDK 不在范围内。
- **响应体**：只在 HTTP ≥ 400 时保存响应原文；成功的流式响应不落盘，避免影响流式行为。
- **配额**：`maxTotalBytes`、`retentionDays` 到点会从最旧的 case 开始删除；触发阈值每 5 分钟最多检查一次。
- **工具输出**：`llm_trace` 返回给模型的内容有上限（约 24 KB），完整内容请直接看文件。