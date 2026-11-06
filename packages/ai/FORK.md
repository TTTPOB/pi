# DSH 的 pi-ai 1.3.0-fork1

基线：Pi tag `v1.3.0`，commit `71023aec1546d6d677a65669c5665c0927ce0dd0`。本 fork 只交付 `@earendil-works/pi-ai`；其他 Pi 子包继续使用官方版本。

## 为什么仍需要 fork

DSH `dsh-v0.2.2-rc.1` 在根工作区为 pi-ai 1.3.0 声明 package patch，已发布的 `@deepseek-ai/dsh-llm-pi-ai@0.2.2-rc.1` 消费者不会继承该源码 patch。消费者必须用 override 将所有 pi-ai 依赖替换为本 fork。独立消费者 smoke 会核对 adapter 与直接导入解析到同一份 pi-ai，并对比官方版本的行为。

## 保留的四项改动

1. Anthropic Messages、Bedrock、Mistral、OpenAI Completions、OpenAI Responses shared、pi-messages 不在每次 JSON 工具参数 delta 上解析 JSON，保留原始 delta 和各自结束阶段的解析。六处与 DSH 0.2.2 patch 净行为一致；grammar/custom 工具处理不变。`test/final-tool-arguments.test.ts` 对六种 API 验证 delta 与最终参数。
2. `OpenAIResponsesCompat.systemPromptFormat?: "input" | "instructions"` 默认 `"input"`。`"instructions"` 将归一后首条系统消息的文本与 sections 放到顶层 instructions，input 不重复该提示。中途系统消息继续使用 1.3.0 transcript 规则：不支持时折叠，支持时保留位置与工具增量。字段现定义于 `src/providers/compat-schema.ts`，类型由 schema 推导。
3. OpenAI Responses 在 `cacheRetention: "none"` 时保留 sessionId 身份/路由 header，但不发送 prompt_cache_key；显式 header 覆盖规则不变。仅作用于 Responses。
4. OpenAI Responses 流退化检测：每个输出项分别累计文本、refusal、推理、函数参数及自定义工具输入的 delta；连续空白或周期 1–100 的严格重复达到阈值时中断，以 `degenerate output` 错误标为可重试。`model.compat.maxConsecutiveWhitespaceChars`、`maxRepeatedPatternChars` 默认各为 32768 UTF-16 code units，0 关闭对应检测。纯空白也会命中周期 1，完全关闭需两项均为 0。工具参数未完成时不发 toolcall_end。

Pi 1.3.0 没有上述四项等价实现。上游新增的兼容性 schema、configuration_update effort 与结束阶段 JSON 修复逻辑直接沿用，不重复实现。

## Gemini 签名移植

沿用 DSH 上游 `e8e43fc4c0` 的 pi-ai 1.3.0 patch：OpenAI Completions 接收工具调用的 `extra_content.google.thought_signature`，保存到对应工具调用的 thoughtSignature；回放时还原到原调用，不把旧 OpenRouter encrypted reasoning 签名当作 Gemini 签名。只接受非空字符串，支持仅携带签名的 delta。`test/openai-completions-gemini-signature.test.ts` 参照 DSH `b235acebb2` 协议往返回归，验证并行调用仅第一条签名、收发和历史对象不变。

## 本地构建与测试

使用原仓库 npm 工具链，仅安装所需 workspace。模型 JSON 属于忽略的生成数据：先在空目录运行 `npm pack @earendil-works/pi-ai@1.3.0 --ignore-scripts` 并解包，将其 `package/dist/providers/data/.` 复制到本地 `packages/ai/src/providers/data/`。check:model-data 会核对 manifest/hash，不重新抓取模型数据。

在仓库根执行：

```sh
export NODE_OPTIONS=--max-old-space-size=4096
npm install --ignore-scripts --package-lock=false --workspace packages/ai --workspace packages/telemetry --include-workspace-root
npm run build --workspace packages/telemetry
npm run check:model-data --workspace packages/ai
npm run build:offline --workspace packages/ai
mkdir -p .artifacts
npm pack --ignore-scripts --workspace packages/ai --pack-destination "$PWD/.artifacts"
cd packages/ai
env -i PATH="$PATH" HOME="$PWD/../../.artifacts/test-home" NODE_OPTIONS="$NODE_OPTIONS" PI_NO_LOCAL_LLM=1 AWS_EC2_METADATA_DISABLED=true node ../../node_modules/vitest/dist/cli.js --run --maxWorkers=2 test/final-tool-arguments.test.ts test/openai-responses-fork-compat.test.ts test/openai-responses-whitespace-guard.test.ts test/openai-completions-gemini-signature.test.ts
```

`.artifacts/` 已被根 .gitignore 忽略。模型数据及 tarball 不提交。

根 lockfile 沿用合并后的上游 1.3.0 依赖图；单包 fork 的 prerelease 与其他 Pi workspace 要求的精确官方版本不匹配，因此不用于 npm ci。选定 workspace 安装显式使用 `--package-lock=false`。根 `npm run check` 的 coding-agent install-lock 校验也会因该版本不匹配失败，属单包交付的已知例外，不修改其他 Pi 包规避。验收以 Pi AI scoped 构建、测试和独立 tarball 消费者 smoke 为准。

## 独立消费者 smoke

分别创建两个空临时目录，各放一份 `scripts/smoke-dsh-fork.mjs`。消费者 package.json 声明 `private: true`、`type: "module"`，依赖 `@deepseek-ai/dsh-llm-pi-ai: "0.2.2-rc.1"` 与 pi-ai；pnpm-workspace.yaml 中 override **所有** `@earendil-works/pi-ai` 为 tarball 的绝对 `file:` 路径。运行 `pnpm install --ignore-scripts` 和 `node smoke-dsh-fork.mjs patched`。另一目录 override 为官方精确 `1.3.0`，运行 `official` 模式作对照。消费者使用用户级 pnpm store，不创建项目内 cache。临时目录与用户级 store 跨文件系统时，显式指定 `--store-dir <用户级 store 绝对路径> --package-import-method=copy`，避免 pnpm 自动改用 /tmp 的 store。

smoke 验证实际模块解析、delta 参数快照与最终参数、instructions 不重复、关闭缓存时身份头仍存在及可配置退化检测。所有请求使用内存 mock，不连接真实 provider，不启动 DSH Host。

## GitHub Release

- 长期分支：TTTPOB/pi 的 `fork/daily-driver`。开发使用独立 worktree。
- `DSH Pi AI CI` 在 daily-driver 与 upgrade/** push、目标为 daily-driver 的 PR 上执行离线构建和四份 fork 回归测试。
- 合并到长期分支并确认 CI 通过后，由 `Release DSH Pi AI package` 发布 `pi-ai-v<package.version>`。发布流程从 manifest 推导版本、恢复对应官方模型数据，构建后运行隔离消费者 smoke。
- tag 和 Release 资产不可变，仅由 GitHub Actions 交付，不本地上传、不发布 npm。本地仅跑 scoped 检查；重型 monorepo 验证交给 CI。
