# dsh-llm-trace · 模型请求落盘

一个 DeepSeek Harness (DSH) 插件：把每次模型调用的**完整输入**与**线上请求明细**按需落盘。

主要为**内测新模型、新渠道**服务：新模型被网关以内容审核为由中断（`DataInspectionFailed` 等）、新中转渠道行为可疑（报错口径奇怪、疑似改写请求）时，不用猜——直接看模型当时**实际收到了什么**、网关**实际回了什么**。

## 为什么内测时需要它

内测新模型/新渠道时最常见的三类问题，都能靠落盘证据回答：

| 问题 | 看哪里 |
|---|---|
| 「发着发着就被审核中断了」——到底是哪段内容触发的？ | `request.txt` 逐条消息 + `wire.response.txt` 网关报错原文 |
| 新渠道报错口径和官方不一致，是不是网关自己加的拦截？ | `wire.headers.json` 的 HTTP 状态、响应头指纹、`x-request-id` |
| 请求是不是被渠道改写过（加系统提示词、动 tools）？ | `wire.request.json` 线上原始请求体，和 `request.json` 逻辑请求对照 |

配合 `prev/` 里前几次**成功调用**的快照，失败请求和成功请求可以逐字段对比。

## 安装

把本目录作为本地插件安装到 DSH profile（设置 → 插件 → 添加插件，选本目录；或让 agent 用 `plugin_manager install_bundle` 传本目录绝对路径）。默认**关闭**，不采集任何东西。

## 快速上手（内测流程）

1. **开采集**：设置 → 通用 → 模型请求落盘，拨开开关（volatile 配置，立即生效，无需重启）；或直接对 agent 说「打开模型请求落盘」，它会调 `llm_trace enable`。
2. **正常内测**：该聊就聊。默认 `on-failure` 模式只在调用失败时落盘，日常几乎不占磁盘。
3. **出问题后取证**：对 agent 说「看下刚才那次失败的请求」：
   - `llm_trace list` —— 最近落盘记录
   - `llm_trace show latest` —— 概要、错误原文、最大的几条消息
   - `llm_trace grep "关键词" latest` —— 定位敏感词出现在第几条消息
4. **测完关掉**：`llm_trace disable` 或拨回开关。

### 只盯新模型/新渠道

不想让日常主力模型的调用混进来，在 profile 的 `cordis.patch.yml` 里限定采集范围：

```yaml
- id: llm-trace
  config:
    enabled: true
    mode: always            # 内测期每次调用都落盘，测完改回 on-failure
    onlyModels:             # 只采集这些模型 id；留空 = 全部
      - some-beta-model-1117
    captureHosts:           # 只抓这个渠道域名的出网请求；留空 = 按调用归属
      - relay.example.com
    captureStreamChunks: true   # 需要看流式 chunk 原始行为时再开，体积大
```

## 落盘结构

默认 `~/.dsh/traces/llm`（可改 `outputDir`）：

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

| 模式 | 行为 | 适用 |
|---|---|---|
| `on-failure`（默认） | 只有失败才落盘，附带前 `ringSnapshots`（默认 2）次成功调用做对照 | 常驻开着，等偶发问题 |
| `moderation` | 只落带审核特征（`failurePatterns`）或 HTTP ≥ 400 的失败 | 专盯审核拦截 |
| `always` | 每次调用都落盘 | 内测期短期使用 |

## `llm_trace` 工具

装好后 agent 可直接调用（读取不需要开采集）：

| action | 用途 |
|---|---|
| `status` | 开关、目录、模式、已用空间、case 数 |
| `list` | 最近若干次落盘记录 |
| `show <case\|latest>` | 某个 case 的概要、错误原文、最大的几条消息 |
| `grep <pattern> <case\|latest>` | 在 `request.txt` 里定位词出现在第几条消息 |
| `enable` / `disable` | 切换采集开关 |
| `prune` | 立即按配额清理旧 case |

工具返回给模型的内容有上限（约 24 KB），完整内容直接看落盘文件。

## 配置项

均可在 profile `cordis.patch.yml` 的 `llm-trace` 条目下覆盖：

| 配置 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关（volatile，设置页即时生效） |
| `outputDir` | `~/.dsh/traces/llm` | 落盘根目录，支持 `~` |
| `mode` | `on-failure` | `always` / `on-failure` / `moderation` |
| `onlyModels` | `[]` | 只采集这些模型 id；空 = 全部 |
| `captureWire` | `true` | 包装 `globalThis.fetch` 抓线上原始请求体与响应头 |
| `captureHosts` | `[]` | host 白名单；空 = 按调用作用域归属 |
| `captureErrorBody` | `true` | 保存非 2xx 响应原文 |
| `captureStreamChunks` | `false` | 保存原始流式 chunk，体积大 |
| `includeAuxiliary` | `false` | 是否采集会话标题生成等辅助调用 |
| `ringSnapshots` | `2` | 失败时附带前几次成功调用数量 |
| `maxBodyBytes` | 64 MiB | 单个 wire 请求体上限 |
| `maxTotalBytes` | 2 GiB | 目录总上限，超出按最旧删除 |
| `retentionDays` | `14` | 保留天数；0 = 不按时间清理 |
| `failurePatterns` | `DataInspectionFailed` 等 | 判定审核失败的子串（不区分大小写） |
| `redactHeaders` | `authorization`、`x-api-key` 等 | 写入前打码的请求头 |
| `redactPatterns` | 密钥正则 | 写入前从 body 中清除的密钥 |

配额清理每 5 分钟最多检查一次；`prune` 可立即触发。

## 注意事项

- **落盘目录是敏感目录**：开启后磁盘上保存完整提示词、工具结果与代码片段——这正是它有用的原因。密钥按 `redactPatterns` / `redactHeaders` 打码，但业务内容原样保留，不要把 case 目录随手发给别人或提交进仓库。
- **覆盖范围**：走 Host `globalThis.fetch` 的出网请求 + 经过 `ctx.llm.stream` 的模型调用。其他进程、内嵌浏览器、不走 fetch 的 SDK 不在范围内。
- **成功响应不落盘**：只在 HTTP ≥ 400 时保存响应原文，避免影响流式行为；要看成功调用的流式细节请开 `captureStreamChunks`。
- 判断渠道是否注入/换模型/虚增 token，落盘只是取证的第一步，结论口径参见配套的渠道审计插件（llm-channel-audit）。

## License

个人项目，未附许可证文件；如需复用请先联系作者。