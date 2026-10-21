# DSH 的 pi-ai 1.1.0-fork2

基线：Pi tag `v1.1.0`，commit `abe508e1b`。本 fork 只发布 `@earendil-works/pi-ai`；其他 Pi 子包继续使用官方版本。

## 为什么仍需要 fork

DSH tag `dsh-v0.2.1-rc.1` 在仓库根的 `pnpm-workspace.yaml` 对 pi-ai 1.1.0 声明 `patchedDependencies`，但已发布的 `@deepseek-ai/dsh-llm-pi-ai@0.2.1-rc.1` 只声明 `@earendil-works/pi-ai: ^1.1.0`，tarball 不包含该 patch。其运行时代码保留对 pi-ai 的外部导入。在独立空目录通过 pnpm 11.28.5 安装这两个固定版本后，实际解析到的 pi-ai `openai-completions` 仍在每次工具参数 delta 上运行 `parseStreamingJson`。消费者不会继承 DSH 源码仓库的 patch。

## 保留的改动

1. 将 DSH 上游 patch 的六个 hunk 移到源码：Anthropic Messages、Bedrock、Mistral、OpenAI Completions、OpenAI Responses shared、pi-messages 不再逐 delta 解析 JSON 工具参数，仍保留各自的结束解析及工具参数原始 delta。Anthropic Messages 仅原样应用上游 patch，没有额外修改或分析。grammar/custom 工具的流式处理不变；不新增旧 `toolCallParsing` 选项。
2. `OpenAIResponsesCompat.systemPromptFormat?: "input" | "instructions"` 默认 `"input"`。`"instructions"` 将归一后首条 `SystemMessage` 的文本和 sections 放入顶层 `instructions`，并从 input 中省略该条提示。后续系统消息继续遵循 1.1.0 transcript 规则：不支持中途系统消息时先折叠；支持时保留原位置及工具增量。来自旧 fork commit `744bbc935`，按 1.1.0 新 transcript 结构重写。
3. OpenAI Responses 在 `cacheRetention: "none"` 时仍保留 `sessionId` 对应的身份/路由 header；`prompt_cache_key` 仍关闭，header 显式覆盖规则不变。来自旧 fork commit `d972afc7b`。不扩展到其他 API。

4. OpenAI Responses 流退化熔断：同一输出项（文本、refusal、推理、函数参数、自定义工具输入）末尾连续空白达到 32768 字符，或以 1–100 字符为周期严格重复达到 32768 字符时中断流，错误文案含 `degenerate output` 并归类为可重试；此时工具尚未执行。fork2 新增。

Pi 1.1.0 尚未包含上述四项等价行为。旧 fork `1fe0048d4` 中的旧选项与整套历史不重放，只保留 DSH rc.1 patch 的净行为。

## 本地构建与测试

遵循原仓库 npm 工具链，仅安装所需 workspace；测试不继承真实 API 凭据：

```sh
export NODE_OPTIONS=--max-old-space-size=3072
npm install --ignore-scripts --package-lock=false --workspace packages/ai --workspace packages/telemetry --include-workspace-root
npm run build --workspace packages/telemetry
npm run check:model-data --workspace packages/ai
npm run build:offline --workspace packages/ai
cd packages/ai
env -i PATH="$PATH" HOME="$PWD/../../.artifacts/test-home" NODE_OPTIONS="$NODE_OPTIONS" PI_NO_LOCAL_LLM=1 AWS_EC2_METADATA_DISABLED=true node ../../node_modules/vitest/dist/cli.js --run --maxWorkers=2
pnpm pack --pack-destination /home/tpob/playground/dsh/.upgrade-rc1/tarballs/
```

Pi 将模型 JSON 数据作为忽略的生成文件。为保持 v1.1.0 模型目录不变，本次从独立消费者安装中官方 pi-ai 1.1.0 的 `dist/providers/data` 复制到本地 `src/providers/data`，由 `check:model-data` 核验 manifest/hash 与当前源码目录一致；没有重新抓取或更新模型数据，也没有提交生成文件。

最终 tarball 在另一个空目录中通过消费者的 `pnpm-workspace.yaml` override 安装。override 必须覆盖所有 `@earendil-works/pi-ai` 传递依赖；只添加直接依赖不能保证替换 DSH 的 `^1.1.0`，因为该范围不接受 fork prerelease。将 `scripts/smoke-dsh-fork.mjs` 复制到消费者目录后运行 `node smoke-dsh-fork.mjs patched`，核对实际解析的 fork 版本、JSON delta 保持原样、最终参数正确、Responses instructions 不重复发送、无 cache 时 session identity 仍存在。对官方 1.1.0 消费者运行同一脚本的 `official` 模式，可复现相反的基准行为。无需连接真实 provider。

本次保持 monorepo 根 lockfile 不变：npm 对 fork prerelease 重新解析会把其他 Pi workspace 的依赖升级到额外官方版本，超出本 fork 的单包交付范围。旧 lockfile 不适用于 fork manifest 的 `npm ci`，因此选定 workspace 的安装显式使用 `--package-lock=false`。以独立 tarball 消费者安装验证为交付依据。

## GitHub Release

- 长期发布分支为 `daily-driver`，位于 TTTPOB remote `fork`（github.com/TTTPOB/pi）；本地分支跟踪 `fork/daily-driver`，不跟踪第三方上游 `origin`。
- 开发与测试使用独立分支或 worktree。
- 发布前合并到长期分支并 push，等待 `DSH Pi AI CI`（`.github/workflows/dsh-ci.yml`）通过。
- 仅从长期分支上的提交，通过 GitHub Actions `Release DSH Pi AI package`（`.github/workflows/dsh-release.yml`）发布 `pi-ai-v<package.version>`；tag 和 Release 资产不可变，不上传本地构建，不发布 npm。
- 本机约 13 GB 内存，本地仅执行上述 Pi AI scoped 检查；重型 monorepo 检查交给 CI。
