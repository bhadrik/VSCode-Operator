# Changelog

## 1.2.5

- 优化异常信息返回：仅在 `isException=true` 的异常停靠场景返回 `exception` 详情，减少普通断点与单步时的噪音。 / Refined exception payload behavior: `exception` details are returned only when `isException=true` (exception stops), reducing noise on normal breakpoints and stepping.
- 增加异常判定一致性：统一输出 `isException` 语义，并在调试适配器可用时补充异常能力探测结果。 / Improved exception classification consistency: unified `isException` semantics and added adapter exception-capability probing output when available.

## 1.2.4

- 调整调试快照输出：`debugSnapshot` 不再返回 `exception` 字段，避免误判异常断点。 / Updated debug snapshot output: `debugSnapshot` no longer returns the `exception` field to avoid exception-stop misclassification.
- 明确异常断点判定入口：需使用 `debugGetExceptionInfo` 判断当前是否为异常断点。 / Clarified exception-stop detection: use `debugGetExceptionInfo` to determine whether the current stop is an exception.

## 1.2.3

- 增强调试异常处理：`debugSnapshot/debugStatus/debugGetTopFrame` 现在返回 `stopKind/stopState/stopHint`，可区分 `exception` 与普通断点。 / Improved exception-stop handling: `debugSnapshot/debugStatus/debugGetTopFrame` now return `stopKind/stopState/stopHint` to distinguish `exception` from normal breakpoints.
- 补充 DAP 参数与异常断点处理提示，降低 AI 误判和参数误传。 / Added DAP-parameter and exception-stop guidance to reduce AI misclassification and invalid debug arguments.

## 1.2.2

- 强化 AI 调试防误用：默认要求新调试前先清理旧会话，并补充 DAP 参数获取提示（threadId/frameId/variablesReference）。 / Strengthened safe AI debugging: enforce stop-before-start guidance and added DAP parameter acquisition hints (threadId/frameId/variablesReference).

## 1.2.1

- 完善 AI 调试器使用说明，增加调试会话清理规则与低往返调试提示模板。 / Improved AI debugger guidance with session cleanup rules and low-roundtrip prompt templates.

## 1.2.0

- 新增 AI 可调用的调试器工具，支持断点、线程、调用栈、变量、求值与调试快照。 / Added AI-facing debugger tools for breakpoints, threads, stack traces, variables, evaluate, and debug snapshots.

## 1.1.3

- 问题面板读取支持筛选。 / Added filtering support for Problems panel reading.

## 1.1.2

- 常规更新。 / General maintenance update.

## 1.1.1

- 调整 git 与项目命名相关内容。 / Adjusted git and project naming-related metadata.

## 1.1.0

- 支持多工作区 MCP 路由，并补充指定文件能力与若干修复。 / Added multi-workspace MCP routing, specific-file support, and several fixes.

## 1.0.1

- 增强补全能力。 / Improved completion capabilities.

## 1.0.0

- 发布 1.x 首个正式版本，建立核心 VS Code Operator 工具集。 / First stable 1.x release with the core VS Code Operator toolset.

## 0.0.1

- 初始化 VS Code 扩展与 MCP 服务框架。 / Initial scaffold for the VS Code extension and MCP server framework.
