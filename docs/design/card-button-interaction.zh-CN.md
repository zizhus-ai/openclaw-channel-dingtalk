# 卡片按钮交互设计方案

## 1. 背景与现状

### 1.1 当前卡片系统

钉钉插件使用钉钉卡片平台的模板系统，用户需要自行创建模板并配置 `cardTemplateId` 和 `cardTemplateKey`。卡片有三种状态：

- **执行中（PROCESSING）** — 卡片刚创建，AI 尚未开始输出
- **输出中（INPUTING）** — AI 正在流式输出内容
- **完成（FINISHED）** — AI 输出完毕，卡片定稿

当前卡片只有内容展示能力，没有按钮交互。

### 1.2 痛点

1. 用户必须自己创建模板并配置，门槛高，容易出错
2. AI 执行中需要用户审批敏感操作时，channel 侧无法操作，只能通过终端 CLI 审批
3. 输出中状态用户无法中断 AI 任务
4. AI 回复中包含选择题时，用户只能打字回复，没有按钮交互

### 1.3 OpenClaw 已有能力（上游源码验证）

> 以下路径均为 **OpenClaw 上游仓库**（`openclaw-src`）中的位置，非本钉钉插件仓库。

| 能力 | 上游位置 | 说明 |
|------|----------|------|
| **ChannelExecApprovalAdapter** | `src/channels/plugins/types.adapters.ts` | channel 插件可实现 `execApprovals` adapter（`buildPendingPayload` / `buildResolvedPayload` / `shouldSuppressLocalPrompt` 等），runtime 自动将审批请求转发到渠道 |
| **InteractiveReply 协议** | `src/interactive/payload.ts` | AI 输出 `[[slack_buttons: label:value, ...]]`，runtime `parseSlackDirectives()` 解析为 `InteractiveReplyButtonsBlock`（含 `label` / `value` / `style`） |
| **ReplyPayload.interactive** | `src/auto-reply/types.ts` | deliver 回调中的 `ReplyPayload.interactive` 字段，Discord / Telegram / Slack / 飞书均已实现 |
| **/stop 命令** | runtime 内部 | runtime 识别 stop/abort 文本命令，基于 AbortController 中断 run |
| **飞书卡片按钮参考实现** | `extensions/feishu/src/card-action.ts` | synthetic message + token 去重 + 结构化信封编解码，本方案的主要参考 |

钉钉插件当前**完全没有实现 `execApprovals` adapter**，导致 AI 需要审批时直接过期失败。

### 1.4 部署拓扑假设

OpenClaw runtime 与 channel 插件运行在**同一 Node.js 进程**内。这意味着：

- 进程重启时 runtime 的 `ExecApprovalManager`（进程内状态）与 channel 侧的 `abortRequestedCards` 同时丢失，不存在单边悬空。
- `exec.approval.requested` 事件通过进程内 EventEmitter 传递，无网络延迟。
- synthetic message 注入 `handleDingTalkMessage()` 是同进程函数调用。

本方案基于此假设设计。若后续 runtime 与 channel 分进程部署，需补充审批状态持久化和 reconnect 恢复机制。

## 2. 设计目标

1. **内置模板** — 废弃 `cardTemplateId` / `cardTemplateKey`，用户零配置
2. **工具审批按钮** — AI 执行中需要审批时，在当前 streaming 卡片上动态渲染审批按钮
3. **停止按钮** — 输出中状态固定显示，用户可中断当前 AI 任务
4. **AI 动态按钮** — AI 通过 InteractiveReply 协议声明按钮，完成态渲染
5. **精准路由** — 按钮回调精准绑定到对应的 session，不串不丢
6. **可扩展** — 按钮类型体系支持后续扩展

## 3. 按钮场景全景

### 3.1 三层按钮场景

| | 工具审批按钮 | 停止按钮 | AI 动态按钮 |
|---|---|---|---|
| **用途** | AI 要执行命令，需要用户批准 | 输出中固定显示，用户随时中断 | AI 回复中声明的交互按钮 |
| **来源** | runtime 广播 `exec.approval.requested` | 模板状态驱动 | `ReplyPayload.interactive` |
| **出现阶段** | streaming（执行中） | streaming（输出中） | finished（完成态） |
| **触发** | `execApprovals` adapter | `status = "streaming"` | deliver callback 检测 |

### 3.2 场景示例

**场景 1：工具审批按钮（streaming 阶段）**

```
用户: 帮我清理 /tmp 下的临时文件
AI:   （开始分析，卡片进入 streaming）
      → 卡片：
        ┌────────────────────────────────────┐
        │ 我来检查 /tmp 目录...                │
        │ 发现 3 个超过 30 天的文件             │
        │              [⏹ 停止]               │
        └────────────────────────────────────┘

      → AI 决定执行 rm -rf /tmp/cache/
      → runtime exec.approval.requested
      → 卡片动态追加审批区域：
        ┌────────────────────────────────────┐
        │ 我来检查 /tmp 目录...                │
        │ 发现 3 个超过 30 天的文件             │
        │ ───────────────────────             │
        │ 🔒 AI 请求执行命令                   │
        │ rm -rf /tmp/cache/                  │
        │  [允许一次]  [始终允许]  [拒绝] [⏹停止] │
        └────────────────────────────────────┘

      → 用户点击"允许一次"
      → 审批按钮消失，AI 继续执行
      → 卡片继续 streaming → 最终 finalize
```

**场景 2：停止按钮**

```
用户: 分析一下这份报告
AI:   （卡片进入 streaming）
        ┌────────────────────────────────────┐
        │ 🤔 正在分析报告...                   │
        │ 首先我来看一下数据结构——              │
        │              [⏹ 停止]               │
        └────────────────────────────────────┘
      → 用户点击"停止"
      → 卡片立即变为完成态，标注"已被用户中断"
      → /stop 命令中断 run
```

**场景 3：AI 动态按钮（finished 阶段）**

```
用户: 帮我设计一个 logo
AI:   （输出中包含 [[slack_buttons: 方案A:plan_a, 方案B:plan_b]]）
      → 卡片完成态：
        ┌────────────────────────────────────┐
        │ 我准备了两个方案：                    │
        │ 方案 A：简约风格...                  │
        │ 方案 B：科技感风格...                │
        │     [方案 A]    [方案 B]             │
        └────────────────────────────────────┘
      → 用户点击"方案 A"
      → synthetic message 注入 session → AI 继续处理
```

## 4. 卡片模板策略

### 4.1 废弃自定义模板配置

废弃 `cardTemplateId` 和 `cardTemplateKey`，统一使用内置模板。config-schema 中标记 deprecated 并忽略，启动时 warn 日志提示移除。

| 配置项 | 变更 |
|--------|------|
| `cardTemplateId` | **废弃删除** |
| `cardTemplateKey` | **废弃删除**，内置模板固定使用 `content` |
| `messageType: "card"` | **保留**，作为开启卡片模式的开关 |

### 4.2 多模板预留

当前只做一个默认模板，预留扩展结构：

```typescript
const BUILTIN_TEMPLATES = {
  default: "tpl_openclaw_default_v1",
} as const;

function resolveCardTemplateId(purpose?: string): string {
  return BUILTIN_TEMPLATES[purpose || "default"] ?? BUILTIN_TEMPLATES.default;
}
```

### 4.3 内置模板变量

扁平变量设计，模板端用简单条件判断渲染：

| 变量名 | 用途 | 示例值 |
|--------|------|--------|
| `content` | 主内容（markdown） | AI 回复文本 |
| `status` | 卡片状态 | `processing` / `streaming` / `finished` |
| `callbackId` | 不透明回调标识（UUID） | `f47ac10b-58cc-...` |
| `approvalId` | 当前审批 ID（空=无审批） | `a1b2c3` |
| `approvalCommand` | 审批命令显示文本 | `rm -rf /tmp/cache/` |
| `approvalExpiresAt` | 审批过期提示（**静态文本**，不实时倒计时） | `"120秒后过期"` |
| `interactiveButtons` | AI 动态按钮 JSON 数组 | `[{"label":"方案A","value":"plan_a"}]` |

模板渲染逻辑：

```
status == "processing"                        → 骨架屏，无按钮
status == "streaming"                         → 内容 + 停止按钮
status == "streaming" && approvalId != ""     → 内容 + 审批按钮 + 停止按钮
status == "finished"                          → 内容 + 反馈按钮
status == "finished" && interactiveButtons    → 内容 + 动态按钮 + 反馈按钮
```

只有三种渲染状态。插件内部的 `FAILED` 状态触发 markdown fallback，不映射到模板。

**状态映射**：模板变量 `status` 与 card-service 内部 `AICardStatus` 的对应关系：

| 模板变量 `status` | card-service `AICardStatus` | 说明 |
|---|---|---|
| `processing` | `PROCESSING` (1) | 卡片刚创建，AI 未开始输出 |
| `streaming` | `INPUTING` (2) | AI 正在流式输出 |
| `finished` | `FINISHED` (3) | AI 输出完毕 |
| — | `FAILED` (5) | 不映射到模板，触发 markdown fallback |

各变量通过 `PUT /v1.0/card/instances` 的 `updateCardDataByKey: true` 独立更新，互不覆盖。

## 5. 回调路由

### 5.0 回调 payload 实际结构（Phase 0 验证结果）

> 以下数据来自 2026-03-21 真机测试，钉钉卡片按钮类型 `sendCardRequest` 回调。

**顶层字段**：

| 字段 | 类型 | 说明 | 示例 |
|------|------|------|------|
| `corpId` | string | 企业 ID | `"ding733ecd052f9f9895"` |
| `spaceType` | string | 空间类型 | `"im"` |
| `userId` | string | **点击按钮的用户 ID** | `"2031332868844862"` |
| `outTrackId` | string | 卡片实例 ID（创建时传入） | `"card_e51d732b-..."` |
| `spaceId` | string | 会话 ID（与 conversationId 对应） | `"cidRYjRaohhX..."` |
| `type` | string | 回调类型 | `"actionCallback"` |
| `extension` | string | 扩展信息（目前为空 JSON） | `"{}"` |
| `content` | string | 按钮动作 JSON（与 `value` 相同） | 见下方 |
| `value` | string | 按钮动作 JSON（与 `content` 相同） | 见下方 |

**`content` / `value` 解析后结构**：

```json
{
  "cardPrivateData": {
    "actionIds": ["btn_approve0"],
    "params": {
      "action": "allow"
    }
  }
}
```

- `actionIds`：数组，通常只有一个元素
- `params`：按钮 event 中定义的 `params` 原样回传

**关键发现：actionId 索引后缀**

钉钉会在 `btns` 数组中每个按钮的 `actionId` 后追加该按钮在数组中的索引号：

| 定义的 actionId | 数组索引 | 回调返回的 actionId |
|----------------|---------|-------------------|
| `btn_approve` | 0 | `btn_approve0` |
| `btn_approve_once` | 1 | `btn_approve_once1` |
| `btn_deny` | 2 | `btn_deny2` |
| `btn_stop`（固定按钮） | — | `btn_stop`（无后缀） |

规律：动态数组 `btns` 中的按钮 actionId 被追加索引，模板中固定定义的按钮（如停止按钮）不追加。

**影响**：回调路由不能用 `===` 精确匹配，需用 `startsWith()` 前缀匹配。或者在模板端将 actionId 本身作为 params 的一部分传递，绕过索引后缀问题（推荐方案）。

### 5.1 服务端存储 + 不透明 callbackId

卡片变量中只存一个 UUID，完整上下文存在服务端：

```
创建卡片时:
  callbackId = randomUUID()
  服务端持久化: callbackId → CardCallbackRecord
  卡片变量写入: callbackId

回调到达时:
  从 params 提取 callbackId → 服务端查找上下文
  查不到 → 过期或非法，拒绝处理
```

```typescript
interface CardCallbackRecord {
  sessionKey: string;
  accountId: string;
  conversationId: string;
  conversationType: "1" | "2"; // "1"=单聊, "2"=群聊
  senderId: string;          // 发起对话的用户，用于审批权限校验
  senderNick: string;
  outTrackId: string;
  currentApprovalId: string; // 当前待处理审批 ID（审批到达时更新，审批完成时清空）
  createdAt: number;
}
```

使用 `persistence-store` namespace 存储，重启后从磁盘恢复。

**TTL 策略**：

| 存储 | TTL | 理由 |
|------|-----|------|
| `CardCallbackRecord` | 72 小时 | 动态按钮在 finished 卡片上，用户可能隔天才点击；72h 覆盖大多数工作场景 |
| `abortRequestedCards` | 30 分钟 | 长任务（文档处理、复杂推理）可能持续数十分钟；30 分钟覆盖绝大多数场景 |
| `beginCardActionToken` | 15 分钟 | 防止用户短时间内重复点击，15 分钟足够覆盖一次完整交互周期 |

### 5.2 回调处理统一入口

**推荐方案：通过 `params.action` 路由（绕过索引后缀）**

由于钉钉对 `btns` 数组中的 actionId 追加索引后缀（§5.0），直接匹配 actionId 不可靠。改用按钮 `event.params` 中自定义的 `action` 字段路由，该字段原样回传不被修改：

```
TOPIC_CARD 回调到达
  │
  ├─ 解析 content → cardPrivateData
  │
  ├─ actionId = "feedback_up/down"                → 现有反馈逻辑（不变）
  ├─ actionId = "btn_stop"                        → 停止按钮处理（模板固定按钮，无索引后缀）
  ├─ params.action = "allow"                      → 审批：允许（始终）
  ├─ params.action = "allow-once"                 → 审批：允许一次
  ├─ params.action = "deny"                       → 审批：拒绝
  └─ params.action = "dynamic_<encoded_value>"    → AI 动态按钮处理
```

**回调解析伪代码**：

```typescript
function resolveCardAction(payload: CardCallbackPayload): CardAction {
  const content = JSON.parse(payload.content);
  const actionIds = content.cardPrivateData?.actionIds ?? [];
  const params = content.cardPrivateData?.params ?? {};
  const actionId = actionIds[0] ?? "";

  // 模板固定按钮：actionId 无索引后缀，直接匹配
  if (actionId === "btn_stop") return { type: "stop" };
  if (actionId === "feedback_up" || actionId === "feedback_down") return { type: "feedback", actionId };

  // btns 数组按钮：通过 params.action 路由（绕过索引后缀）
  switch (params.action) {
    case "allow":       return { type: "approve", decision: "allow-always" };
    case "allow-once":  return { type: "approve", decision: "allow-once" };
    case "deny":        return { type: "approve", decision: "deny" };
    default:
      // 动态按钮：params.action 以 "dynamic_" 开头
      if (typeof params.action === "string" && params.action.startsWith("dynamic_")) {
        const encodedValue = params.action.slice("dynamic_".length);
        return { type: "dynamic", value: base64urlDecode(encodedValue) };
      }
      return { type: "unknown", actionId, params };
  }
}
```

动态按钮的 `params.action` 格式为 `dynamic_<encoded_value>`，其中 `encoded_value` 是 value 的 URL-safe Base64 编码（`base64url(value)`）。编码原因：value 来自 AI 输出，可能包含空格、冒号等特殊字符。编码后确保每个按钮独立去重且不会互相误杀。

### 5.3 抗重复点击

```typescript
// 进程内 Map，TTL 15 分钟
// key = callbackId:userId:actionId
function beginCardActionToken(callbackId, userId, actionId): boolean;
```

key 包含 userId：群聊中多个用户可能点击同一卡片的同一按钮，每个用户的点击独立处理。

停止按钮本身是幂等操作，多人点击时第一个生效，后续由 `abortRequestedCards` 标记自然忽略。

### 5.4 审批权限校验

**群聊中只有发起对话的用户可以审批**。审批代表对敏感命令的授权，不应允许群内任意成员操作：

```typescript
// 审批按钮回调入口
if (actionId.startsWith("btn_approve_")) {
  const record = lookupCallbackContext(callbackId, storePath);
  if (record && callbackUserId !== record.senderId) {
    return { response: "toast", text: "仅发起对话的用户可以审批" };
  }
}
```

停止按钮和 AI 动态按钮不做此限制——群内任何用户都可以停止或参与选择。

### 5.5 卡片状态 guard

deliver callback 入口处增加双重保护，防止已停止的卡片被拉回 streaming：

```typescript
// Guard 1: abortRequestedCards 标记（30 分钟 TTL，高频优化）
if (abortRequestedCards.has(outTrackId)) return;

// Guard 2: 卡片实例状态检查（无 TTL 限制）
if (currentAICard?.state === "FINISHED") return;
```

两层 guard 职责不同：Guard 1（`abortRequestedCards`）是**高频短期优化**，覆盖 TTL 内的大多数场景，避免每次都查询卡片状态；Guard 2（卡片实例状态检查）是**真正的安全边界**，无 TTL 限制，即使 Guard 1 过期也能拦截。

## 6. 工具审批按钮

### 6.1 时序

审批发生在 streaming 阶段。AI 被挂起等待审批，卡片仍在 streaming 状态，审批按钮出现在当前卡片上。

### 6.2 execApprovals adapter

```typescript
execApprovals: {
  buildPendingPayload({ cfg, request, target, nowMs }) { ... },
  buildResolvedPayload({ cfg, resolved, target }) { ... },
  shouldSuppressLocalPrompt({ cfg, accountId }) { return true; },
}
```

### 6.3 审批按钮追加

审批请求到达时，通过 `PUT /v1.0/card/instances` 更新扁平变量。**入口处先检查停止标记**，防止与停止按钮竞态（见 §7.3）：

```typescript
// 竞态防护：如果用户已点击停止，跳过审批变量写入
if (abortRequestedCards.has(currentOutTrackId)) {
  log?.warn("Approval skipped: card already stopped");
  return buildTextFallback(request); // 降级为纯文本
}

// 更新服务端存储的 currentApprovalId（不从客户端 params 读取，防注入）
// 写入失败时 currentApprovalId 不会被更新（保持上次值或空），通过文本 fallback 兜底
const storeSuccess = updateCallbackRecord(callbackId, { currentApprovalId: request.id });

if (!storeSuccess) {
  log?.error("Failed to write currentApprovalId to store, falling back to text");
  await sendTextFallback(target, `🔒 AI 请求执行命令：\n${request.request.command}\n请回复 /approve ${request.id} allow-once`);
  return; // 阻断后续 PUT——即使卡片显示了按钮，用户点击也会因 §6.4 精确匹配失败而无效
}

const putSuccess = await updateCardVariables(currentOutTrackId, {
  approvalId: request.id,
  approvalCommand: request.request.command,
  approvalExpiresAt: `${expiresIn}秒后过期`,  // 静态文本，不实时倒计时（见 §4.3）
}, token, config);

// PUT 失败时主动降级：发文本消息告知用户手动审批
// 不能只 log.error——否则 AI 挂起等审批，用户看不到按钮，形成死等
if (!putSuccess) {
  log?.error("Failed to PUT approval buttons, falling back to text");
  await sendTextFallback(target, `🔒 AI 请求执行命令：\n${request.request.command}\n请回复 /approve ${request.id} allow-once`);
}
```

streaming API 和 instances API 更新卡片的不同部分，互不干扰。card-draft-controller 不需要改动。

> **待验证**：streaming API 与 instances API 并发调用的安全性需在 Phase 1 前通过 POC 验证（见 §14）。

### 6.4 用户点击

```
用户点击"允许一次"
  → 通过 callbackId 查找 CardCallbackRecord
  → 从 record.currentApprovalId 获取审批 ID（服务端存储，不可被客户端篡改）
  → 精确匹配校验: record.currentApprovalId 必须非空且与当前审批 ID 一致（防止 store 清空失败后的陈旧 ID 误触发）
    → 若校验失败（currentApprovalId 为空或不匹配）→ 返回 toast "审批信息已失效，请回复 /approve xxx allow-once"
  → 校验 approvalId 格式: /^[a-zA-Z0-9_-]+$/（防注入）
  → 校验权限: callbackUserId === record.senderId（仅发起者可审批）
  → 构造 synthetic message: "/approve <id> allow-once"
  → injectSyntheticMessage({ senderId, text, skipAck: true })
  → runtime resolve → AI 继续
  → PUT card 清除审批变量（approvalId = "", currentApprovalId = ""）
```

**注入防护**：`approvalId` 从服务端 `CardCallbackRecord.currentApprovalId` 读取（审批到达时由 adapter 写入），不从回调 payload 的 params 中读取。即使攻击者伪造回调 payload，也无法控制 synthetic message 的内容。

### 6.5 审批过期 / 拒绝

- decision = null（过期）→ 清除审批变量 + content 追加"审批已过期"
- decision = "deny" → 清除审批变量 + content 追加"已拒绝"

### 6.6 多次审批

AI 工具调用是串行的（twoPhase 审批等待返回后才继续下一个工具），所以审批不会并发。`approvalId` 只存当前待处理的审批：

```
审批1到达  → approvalId = "a1"
用户允许   → approvalId = "", content 追加 "✅ 已允许 rm -rf ..."
AI 继续执行 → 触发下一个工具
审批2到达  → approvalId = "a2"
```

防护措施：如果因极端时序出现并发审批（approvalId 非空时又收到新审批），adapter 层返回纯文本 fallback（不更新卡片按钮），避免静默覆盖。

## 7. 停止按钮

### 7.1 渲染

内置模板在 `status = "streaming"` 时固定渲染停止按钮，由模板条件控制。

### 7.2 回调处理

即时反馈 + 直接中断（不走 session lock）：

```
用户点击"停止"
  → 通过 callbackId 查找上下文
  │
  ├─ 即时 UI 更新（不等 session lock）：
  │   PUT card → status="finished", content 追加"*已被用户中断*"
  │   abortRequestedCards.set(outTrackId, true)   // 30 分钟 TTL
  │   card-draft-controller.stop()
  │
  └─ 直接 abort runtime（不走 session lock）：
      runtime.abort(sessionKey)
      → runtime AbortController.abort()
```

**为什么不走 synthetic message + session lock**：如果 AI 正在等审批（session lock 被当前 run 持有），synthetic `/stop` 会排在 lock 后面永远执行不到。因此停止按钮直接调用 runtime 的 abort API 绕过 session lock，确保即时生效。

用户点击后卡片瞬间变为完成态，runtime run 同步被 abort。

`abortRequestedCards` 是进程内 Map，**30 分钟 TTL**。deliver callback 入口处通过双重 guard 检查（见 §5.5），确保 stop 后不会把卡片拉回 streaming 状态。

### 7.3 停止与审批的竞态防护

用户点击停止的同时，runtime 可能正好广播 `exec.approval.requested`。需要处理两种竞态：

**竞态 1：停止 vs 审批请求到达**

```
时间线：
  T0: 用户点击停止 → PUT card status="finished" + abortRequestedCards.set() + runtime.abort()
  T1: exec.approval.requested → buildPendingPayload()
                                 ↳ 检查 abortRequestedCards → 命中 → 跳过写入，返回文本 fallback
```

**竞态 2：用户先点审批再点停止**

```
时间线：
  T0: 用户点击"允许一次" → injectSyntheticMessage("/approve <id> allow-once")（排队等 lock）
  T1: 用户点击"停止"     → runtime.abort(sessionKey)（直接生效，不走 lock）
  T2: runtime abort → 当前 run 被中断，审批的 synthetic message 到达时 run 已结束，自然丢弃
```

由于停止按钮直接调用 `runtime.abort()` 不走 session lock，即使审批的 synthetic message 正在排队，abort 也能立即生效。

防护措施：
1. `buildPendingPayload` 入口检查 `abortRequestedCards` 标记（§6.3）
2. 即使因极端时序标记尚未生效，最终卡片 `status="finished"` 时模板不渲染审批按钮（模板条件：`status == "streaming" && approvalId != ""` 才渲染）
3. `runtime.abort()` 直接中断 run，不依赖 session lock 排队

**PUT 失败降级**：如果停止或审批的 PUT card 调用失败：
- 停止场景：`abortRequestedCards` 标记仍然生效，deliver callback 被拦截；`runtime.abort()` 独立于 PUT 调用，run 仍会被中断；卡片状态由 finalize 兜底更新
- 审批场景：fallback 到文本消息提示用户回复 `/approve <id> allow-once`

## 8. AI 动态按钮

### 8.1 触发

OpenClaw InteractiveReply 协议。AI 输出：

```
请选择方案 [[slack_buttons: 方案A:plan_a, 方案B:plan_b]]
```

runtime `parseSlackDirectives()` 解析为 `ReplyPayload.interactive`，无额外 token 消耗。

AI 通过 system prompt 约定学习使用 `[[slack_buttons:...]]` 格式。

### 8.2 渲染

deliver callback 的 finalize 阶段检测 `payload.interactive`：

```typescript
if (payload.interactive?.blocks) {
  const buttons = extractButtonsFromInteractive(payload.interactive);
  if (buttons.length > 0) {
    await updateCardVariables(outTrackId, {
      interactiveButtons: JSON.stringify(buttons),
    }, token, config);
  }
}
await finishAICard(currentAICard, finalText, log);
```

**多 blocks 处理**：若 AI 输出多个 `[[slack_buttons:...]]` 块，`extractButtonsFromInteractive` 合并所有 `InteractiveReplyButtonsBlock` 中的按钮，**上限 6 个**（钉钉卡片按钮区域限制）。超出部分截断并在内容末尾追加文本提示。

**空值校验**：过滤掉 `label` 或 `value` 为空的按钮，避免渲染空白按钮或触发空文本过滤：

```typescript
function extractButtonsFromInteractive(interactive: InteractiveReply) {
  return interactive.blocks
    .filter((b): b is InteractiveReplyButtonsBlock => b.type === "buttons")
    .flatMap(b => b.buttons)
    .filter(btn => btn.label.trim() && btn.value.trim())
    .slice(0, 6)
    .map(btn => ({ label: btn.label, value: btn.value })); // style 字段不传递——钉钉卡片按钮样式由模板统一控制
}
```

### 8.3 回调处理

```
用户点击"方案A"
  → 通过 callbackId 查找 CardCallbackRecord
    → 若 record 不存在（72h TTL 过期） → 返回 toast "按钮已过期，请重新发起对话"
  → 检查 session 存活性：runtime.hasActiveSession(record.sessionKey)
    → 判断依据：runtime 侧 session 是否仍在内存中（未被 GC / 未超时清理）
    → 若 session 不存在 → 返回 toast "会话已结束，请重新发起对话"
    → 若 session 存活 → 继续
  → 从 actionId 提取 base64url 部分并解码为原始 value（解码在 card-action-handler.ts 内完成）
  → PUT card → 按钮变为"已选择: 方案A"
    → 若 PUT 失败 → 仍注入 synthetic message（用户选择不应丢失），同时 toast 通知"选择已收到，但卡片更新失败"
  → injectSyntheticMessage({ senderId=真实用户, text=解码后的value, skipAck: true, writeHistory: true })
  → AI 在同一 session 中继续处理
```

**过期区分**：callbackId 过期（72h）和 session 过期是两种不同场景，toast 文案需区分，帮助用户理解原因。

### 8.4 select 类型

`InteractiveReply` 也支持下拉选择（`[[slack_select:...]]`），后续可渲染为卡片下拉菜单。

## 9. 模块架构

### 9.1 新增模块

```
src/card/
  card-template.ts          ← 内置模板 ID + 变量构建
  card-action-handler.ts    ← 回调统一处理（switch 分发）
  card-callback-store.ts    ← callbackId → context 持久化存储
```

现有模块不做物理迁移：

```
src/
  card-service.ts           ← 现有：卡片 CRUD + streaming API
  card-callback-service.ts  ← 现有：回调 payload 解析（纯解析，无 I/O）
  card-draft-controller.ts  ← 现有：节流流式更新
```

新模块按计划目录落位 `src/card/`，现有模块后续专门迁移 PR 统一搬迁。

### 9.2 职责划分

**`card-template.ts`**

```typescript
export function resolveCardTemplateId(purpose?: string): string;
export function buildCardVariables(params: {
  content: string;
  status: "processing" | "streaming" | "finished";
  callbackId: string;
  approvalId?: string;
  approvalCommand?: string;
  approvalExpiresAt?: string;
  interactiveButtons?: Array<{ label: string; value: string }>;
}): Record<string, string>;
```

**`card-callback-store.ts`**

```typescript
export function storeCallbackContext(callbackId: string, context: CardCallbackRecord, storePath: string): void;
export function lookupCallbackContext(callbackId: string, storePath: string): CardCallbackRecord | null;
```

**`card-action-handler.ts`**

```typescript
export async function handleCardActionCallback(params: {
  analysis: CardCallbackAnalysis;
  payload: unknown;
  config: DingTalkConfig;
  accountId: string;
  runtime: DingTalkRuntime;
  log?: Logger;
}): Promise<void>;
```

### 9.3 channel.ts 变更

```typescript
c.registerCallbackListener(TOPIC_CARD, async (res: any) => {
  const payload = JSON.parse(res.data);
  const analysis = analyzeCardCallback(payload);

  if (analysis.feedbackTarget && analysis.feedbackAckText) {
    // 现有反馈逻辑（不变）
    recordExplicitFeedbackLearning({ ... });
  } else if (analysis.actionId) {
    // 新增：按钮动作处理
    await handleCardActionCallback({ analysis, payload, config, accountId, runtime: rt, log });
  }

  socketCallBackResponse(res.headers?.messageId, { success: true });
});
```

注意：`analysis.actionId` 已由现有的 `analyzeCardCallback()` 解析返回（`CardCallbackAnalysis.actionId`），无需修改解析逻辑。

### 9.4 synthetic message 注入

当前 `inbound-handler.ts` 的 `handleDingTalkMessage` 没有 `synthetic` 参数。需要新增 `injectSyntheticMessage` 函数，或在 `handleDingTalkMessage` 增加选项：

```typescript
// 方案：在 inbound-handler.ts 中新增
export async function injectSyntheticMessage(params: {
  senderId: string;
  senderNick: string;
  conversationId: string;
  conversationType: "1" | "2"; // "1"=单聊, "2"=群聊
  text: string;
  skipAck: boolean;
  writeHistory?: boolean; // 是否写入 session history（默认 false）
  config: DingTalkConfig;
  runtime: DingTalkRuntime;
  log?: Logger;
}): Promise<void> {
  // 跳过：access control, ack reaction, learning, feedback, dedup
  // history：按 writeHistory 参数决定（默认 false，动态按钮传 true，/approve 传 false）
  // 执行顺序：session routing / lock → writeHistory 写入（若 true）→ dispatchReply
  // writeHistory 在 dispatch 之前写入，确保 AI 在当次处理时即可看到用户选择
}
```

此函数仅走 session 路由和 dispatch 两步，跳过所有入站消息的前置处理。

**安全前提**：`injectSyntheticMessage` 的调用方（`card-action-handler.ts`）必须已通过钉钉 SDK 的回调签名校验。钉钉 SDK 在 WebSocket 层对 TOPIC_CARD 回调做签名验证，未通过签名的回调不会到达业务代码。因此 `injectSyntheticMessage` 本身不需要重复校验签名，但必须确保**只在回调处理链路内被调用**，不对外暴露为公共 API。

### 9.5 execApprovals adapter

```typescript
export const dingtalkPlugin = {
  execApprovals: {
    buildPendingPayload({ cfg, request, target, nowMs }) { ... },
    buildResolvedPayload({ cfg, resolved, target }) { ... },
    shouldSuppressLocalPrompt({ cfg, accountId }) { return true; },
  },
};
```

## 10. 卡片生命周期

```
        用户发送消息
            │
            ▼
    ┌─ createAICard() ──┐
    │  status=processing  │
    │  callbackId=UUID    │
    └───────┬────────────┘
            │
            ▼
    ┌─ streamAICard() ──────────────────────────┐
    │  status=streaming                           │
    │                                             │
    │  停止按钮（固定显示）                         │
    │    用户点击 → 即时 finalize + /stop abort    │
    │                                             │
    │  审批按钮（按需出现）                         │
    │    exec.approval → 追加审批变量              │
    │    用户点击 → /approve → AI 继续             │
    │    清除审批变量，恢复 streaming               │
    │    （可能多次审批）                           │
    └───────┬──────────────────────────────────┘
            │
            ▼
    ┌─ finishAICard() ──┐
    │  status=finished   │
    │  interactiveButtons│  ← AI 动态按钮（如果有）
    └───────┬────────────┘
            │
     用户点击动态按钮？→ synthetic message → AI 继续
            │
           结束
```

## 11. 降级与边界场景

### 11.1 markdown 模式降级

无卡片时的降级行为：

| 场景 | 降级 |
|------|------|
| 停止按钮 | 用户手动发送 `/stop` |
| 审批按钮 | 文本消息："🔒 请回复 `/approve <id> allow-once`" |
| AI 动态按钮 | 按钮 label 作为纯文本列出 |

### 11.2 反馈按钮

`status = "finished"` 时模板固定渲染反馈按钮。反馈回调走现有 `analyzeCardCallback` → `recordExplicitFeedbackLearning` 流程，不进入 `handleCardActionCallback`。

### 11.3 卡片恢复

重启后审批 ID 已过期（`ExecApprovalManager` 是进程内状态），恢复时 finalize 卡片自然清空审批变量。callbackId 对应的上下文从磁盘恢复。

### 11.4 卡片 PUT 更新失败降级

| 场景 | PUT 失败后果 | 降级策略 |
|------|------------|---------|
| 停止 | 卡片未变为 finished，但 `abortRequestedCards` 标记生效 | deliver callback 被拦截不再更新；等 run 中断后由 finalize 兜底更新卡片状态 |
| 审批 | 卡片无审批按钮，用户无法操作（包含 PUT 卡片失败和 store 写入失败两种情况） | 主动 fallback 到文本消息："🔒 请回复 `/approve <id> allow-once`"（见 §6.3） |
| 动态按钮（finalize 时） | finished 卡片无按钮 | 按钮 label 作为纯文本列出在 content 末尾 |
| 动态按钮（点击时） | 按钮未变为"已选择"状态 | 仍注入 synthetic message（用户选择不丢失），toast 通知"选择已收到，但卡片更新失败" |

### 11.5 动态按钮过期提示

动态按钮有两层过期检查，toast 文案需区分帮助用户理解：

```typescript
// 第一层：callbackId 过期（72h TTL）
const record = lookupCallbackContext(callbackId, storePath);
if (!record) {
  return { response: "toast", text: "按钮已过期，请重新发起对话" };
}

// 第二层：session 过期（runtime 侧 session 已被 GC）
const sessionAlive = runtime.hasActiveSession(record.sessionKey);
if (!sessionAlive) {
  return { response: "toast", text: "会话已结束，请重新发起对话" };
}
```

### 11.6 synthetic 消息行为

停止按钮**完全不走 `injectSyntheticMessage`**——即时 UI 更新（PUT card + controller.stop()）和 runtime abort 均直接调用，不涉及 session lock（见 §7.2）。以下仅描述通过 `injectSyntheticMessage` 发送的 synthetic 消息（/approve、动态按钮回调）：

`injectSyntheticMessage()` 跳过的步骤：

| 步骤 | 行为 | 说明 |
|------|------|------|
| access control | **跳过** | 已通过钉钉 SDK 签名校验 |
| ack reaction | **跳过** | 按钮回调不需要 ack |
| learning / feedback | **跳过** | 系统操作，非学习素材 |
| history 记录 | **按类型区分** | 动态按钮回调（`writeHistory: true`）：用户选择是上下文的一部分，AI 需要知道用户做了什么选择；/approve（`writeHistory: false`）：系统审批操作，不应污染对话历史 |
| dedup | **跳过** | 由 `beginCardActionToken` 在上层去重 |
| session routing / lock | **正常执行**（排队等待 lock） |
| dispatchReply | **正常执行** |

## 12. 架构文档更新

### 12.1 Card 领域扩展

对 `docs/ARCHITECTURE.zh-CN.md` 的 Card 域做以下修改：

```diff
 ### Card

 负责：

 - AI Card 创建 / 流式更新 / 结束态流程
 - 待恢复卡片状态与缓存
 - 卡片特有的 fallback 行为
+- 内置卡片模板 ID 解析与变量构建
+- 卡片按钮回调统一分发（停止 / 审批 / 动态按钮）
+- 回调上下文持久化存储（callbackId → CardCallbackRecord）
+- 工具审批的渠道定制化消息构建（execApprovals adapter）

 示例：

 - `src/card-service.ts`
 - `src/card-callback-service.ts`
+- `src/card/card-template.ts`
+- `src/card/card-action-handler.ts`
+- `src/card/card-callback-store.ts`
```

计划目录结构的 `card/` 部分同步更新：

```diff
   card/
     card-service.ts
     card-callback-service.ts
+    card-template.ts
+    card-action-handler.ts
+    card-callback-store.ts
```

### 12.2 Gateway 域扩展

```diff
+- `injectSyntheticMessage` 供 Card 域注入合成消息（/approve、动态按钮回调）
```

### 12.3 跨域依赖说明

`card-action-handler.ts`（Card 域）调用 `injectSyntheticMessage`（Gateway 域）注入 synthetic message。飞书插件同模式（`card-action.ts` → `handleFeishuMessage`）。如果后续 OpenClaw 暴露 `chat.send` / `chat.abort` 到插件接口，可消除此跨域依赖。

## 13. 实施分阶段

### Phase 0（前置验证）：POC spike

> **必须在 Phase 1 之前完成**，验证方案的核心技术假设。**Phase 0 未通过验收前，Phase 1 不得启动。**

验证项：

- 创建测试卡片模板，验证内置 templateId 跨应用可用性
- 验证 streaming API 与 instances API 并发调用是否安全（同一张卡片同时 PUT streaming 和 PUT instances）
- 记录钉钉卡片按钮区域的限制（最大按钮数、label 长度等）
- 验证钉钉卡片回调 params 的传值机制（JSON 变量解析、用户 ID 字段）
- 确认群聊场景下回调返回的用户标识（点击者 vs 发起者），影响 §8.3 动态按钮 senderId 设计

**Go/No-Go 验收标准**：

| 验证项 | Go 条件 | No-Go 后备方案 |
|--------|---------|---------------|
| 内置 templateId | 至少一个测试应用可正常创建和更新卡片 | plan B：提供模板 JSON + 一键创建脚本 |
| streaming + instances 并发 | 同一张卡片双 API 调用不丢数据、不报错 | 改为独立审批卡片（类似飞书方案） |
| 回调 params 传值 | JSON 变量可正确传递和解析 | 改为 actionId 编码方案（信息写入 actionId 而非 params） |
| 群聊用户标识 | 明确回调中用户 ID 字段的含义 | 根据实际字段调整 §8.3 senderId 策略 |

输出：技术可行性报告 + Go/No-Go 决策记录

### Phase 1：内置模板 + 工具审批按钮 + 停止按钮

- 创建内置卡片模板（含模板部署文档/脚本）
- `card-template.ts`、`card-callback-store.ts`、`card-action-handler.ts`
- `injectSyntheticMessage` 函数（Gateway 域，含 `writeHistory` 参数，Phase 1 默认 false，Phase 2 动态按钮传 true）
- 废弃 `cardTemplateId` / `cardTemplateKey`
- `execApprovals` adapter（含审批权限校验、竞态防护）
- 停止按钮（即时 UI 更新 + 直接 runtime.abort()）
- token 去重 + 卡片状态 guard
- 更新架构文档 Card 域
- **测试要求**：须覆盖 §16.1 的 `card-template.ts`、`card-callback-store.ts`、`card-action-handler.ts` 单元测试，及 §16.2 的审批完整流程、停止完整流程、竞态（停止+审批）集成测试。PR 无测试 → 强制 Request Changes

### Phase 2：AI 动态按钮

- deliver callback 检测 `payload.interactive`
- `extractButtonsFromInteractive`（含空值校验、数量上限）
- finalize 时写入 `interactiveButtons` 变量
- 动态按钮回调 → synthetic message（含 session 存活性检查）
- 过期按钮 toast 提示
- system prompt 约定文档

### Phase 3：扩展

- select 下拉选择
- 多模板扩展
- 向 OpenClaw 上游提 `chat.abort` / `chat.send` plugin API feature request

## 14. 安全考量

### 14.1 攻击面与防护汇总

| 攻击面 | 威胁 | 防护措施 | 位置 |
|--------|------|---------|------|
| 回调伪造 | 攻击者伪造 TOPIC_CARD 回调注入恶意操作 | 钉钉 SDK WebSocket 层签名校验；`injectSyntheticMessage` 不对外暴露 | §9.4 |
| approvalId 注入 | 通过回调 payload 篡改审批 ID | approvalId 从服务端 `CardCallbackRecord.currentApprovalId` 读取，不从客户端 params 读取 | §6.4 |
| 越权审批 | 群聊中非发起者审批敏感命令 | `callbackUserId === record.senderId` 校验 | §5.4 |
| 重复点击 | 同一按钮被多次触发 | `beginCardActionToken` 去重（15 分钟 TTL，key 含 userId + actionId） | §5.3 |
| synthetic message 注入 | 通过按钮回调构造恶意命令 | approvalId 格式校验 `/^[a-zA-Z0-9_-]+$/`；动态按钮 value 来自 AI 输出而非用户输入 | §6.4, §8.3 |
| callbackId 枚举 | 猜测 UUID 访问他人卡片上下文 | UUID v4 熵足够（122 bit）；72h TTL 限制窗口 | §5.1 |

### 14.2 信任边界

```
钉钉平台（签名校验）
  └─ TOPIC_CARD 回调 → SDK 层已验证
      └─ card-action-handler（本方案）
          ├─ callbackId → 服务端查找（不信任客户端 params）
          ├─ approvalId → 服务端读取（不信任客户端 params）
          └─ injectSyntheticMessage → 仅内部调用
```

## 15. 可观测性

### 15.1 关键事件日志

| 事件 | 日志级别 | 关键字段 |
|------|---------|---------|
| 按钮回调到达 | `info` | `actionId`, `callbackId`, `userId` |
| 审批请求到达 | `info` | `approvalId`, `command`, `outTrackId` |
| 审批用户操作 | `info` | `approvalId`, `decision` (allow-once/allow-always/deny) |
| 停止按钮点击 | `info` | `outTrackId`, `userId` |
| 动态按钮点击 | `info` | `callbackId`, `buttonValue`, `userId` |
| 去重拦截 | `debug` | `callbackId`, `actionId`, `reason: "duplicate"` |
| 权限拒绝 | `warn` | `callbackId`, `userId`, `senderId`, `reason: "not_sender"` |
| callbackId 过期 | `warn` | `callbackId`, `reason: "expired_or_not_found"` |
| PUT card 失败 | `error` | `outTrackId`, `httpStatus`, `errorMessage` |
| store 写入失败 | `error` | `callbackId`, `operation`, `errorMessage` |

### 15.2 监控指标（建议）

- 按钮点击总量（按 actionId 类型分组）
- 审批响应时间（从 `exec.approval.requested` 到用户点击）
- 去重命中率
- PUT card 失败率

## 16. 测试策略

### 16.1 单元测试

| 模块 | 测试重点 |
|------|---------|
| `card-template.ts` | `resolveCardTemplateId` 返回正确 ID；`buildCardVariables` 各状态组合下变量正确 |
| `card-callback-store.ts` | 存取正确性；TTL 过期后返回 null；并发读写安全 |
| `card-action-handler.ts` | actionId 路由正确；权限校验拒绝非发起者；去重 token 拦截重复点击；过期 callbackId 返回 toast。**mock 策略**：`injectSyntheticMessage` 和 `runtime.abort` 通过依赖注入 mock，验证调用参数（text、senderId、writeHistory）而非实际执行 |
| `extractButtonsFromInteractive` | 空值过滤；上限截断；多 blocks 合并；style 字段剥离 |

### 16.2 集成测试

| 场景 | 验证项 |
|------|--------|
| 审批完整流程 | `exec.approval.requested` → 卡片变量更新 → 用户点击 → synthetic message → runtime resolve |
| 停止完整流程 | 点击停止 → 即时 UI 更新 → abortRequestedCards 标记 → deliver callback 被拦截 |
| 竞态：停止 + 审批 | 同时触发两者，验证 abortRequestedCards 标记优先 |
| 竞态：审批 + 审批 | 模拟并发审批到达，验证 fallback 到文本 |

### 16.3 Phase 0 POC 验证项

- 内置 templateId 跨应用可用性
- streaming API 与 instances API 并发调用安全性
- 钉钉卡片按钮区域限制（最大按钮数、label 长度）
- ~~钉钉卡片回调 params 的传值机制~~ ✅ 已验证（2026-03-21）：`event.params` 原样回传至 `cardPrivateData.params`；actionId 被追加数组索引后缀（见 §5.0）
- ~~回调中点击者用户标识~~ ✅ 已验证（2026-03-21）：顶层 `userId` 为点击者 ID

## 17. 开放问题

| # | 问题 | 状态 | 解决方案/进展 |
|---|------|------|-------------|
| 1 | 内置模板 templateId 是否所有应用都能用同一模板 | **Phase 0 验证** | 若不可行，plan B：提供模板 JSON + 一键创建脚本 |
| 2 | 钉钉卡片 streaming API 与 instances API 并发调用是否安全 | **Phase 0 验证** | 若不安全，改为独立审批卡片（类似飞书方案） |
| 3 | `InteractiveReply` 指令名 `slack_buttons` 是否需要钉钉侧别名 | 可直接复用 | 上游协议不区分渠道，钉钉侧原样使用 |
| 4 | `cardTemplateId` 废弃后的版本迁移期 | Phase 1 确定 | config-schema deprecated 标记 + 启动 warn 日志 |
| 5 | 向 OpenClaw 上游提 plugin API feature request | Phase 3 | `chat.abort` / `chat.send` 可消除跨域依赖 |
| 6 | 钉钉卡片回调 params 中 JSON 变量的传值与解析能力 | **已验证 ✅** | `event.params` 中的自定义字段（如 `action: "allow"`）原样回传，通过 `cardPrivateData.params` 获取。但 actionId 会被追加数组索引后缀（§5.0），需用 params 路由绕过 |
| 7 | 停止按钮直接调用 runtime.abort() 的具体 API 签名 | **Phase 1 确认** | runtime 支持 /stop 命令，对应 AbortController.abort()；需确认插件侧可调用的具体方法名和参数 |
| 8 | 回调中点击者用户标识 | **已验证 ✅** | 回调顶层 `userId` 字段为**点击按钮的用户 ID**（非卡片创建者）。群聊中可用此字段做审批权限校验（`userId === record.senderId`）。§8.3 动态按钮的 senderId 直接使用回调 `userId` |
| 10 | 钉钉 `btns` 数组按钮的 actionId 被追加索引后缀 | **已验证 ✅** | 钉钉平台行为：`btns[i]` 的 actionId 后追加索引 `i`（如 `btn_approve` → `btn_approve0`）。模板固定按钮不受影响。回调路由改用 `params.action` 字段（§5.2） |
| 9 | 用户先点审批再点停止时两个操作的执行顺序 | **已解决** | §7.3 竞态 2：/stop 直接调 runtime.abort() 不走 lock，审批 synthetic message 到达时 run 已结束 |
