# dsh-memory-band 实测报告

日期：2026-11-02  
环境：DeepSeek Harness Desktop `0.2.1-rc.5`，profile `desktop`  
模型：`deepseek-account / deepseek-flash`，`reasoningEffort: low`  
preset：`standard`  
测试项目：`bench/fixture/`，12 节 `notes.md`，项目暗号“蓝鲸七号”只出现一次。

## 问题

> 我们之前约定过的项目暗号是什么？只回答暗号本身，不要解释。

对照组（baseline）关闭 `dsh-memory-band`，实验组开启。每次都是**新建会话**，
不复用上一轮的历史。每组跑 2 次。

## 结果

### 基线（插件关闭）

| # | 会话 ID | 输入 token | 输出 token | step | 工具调用 | LLM 耗时 | 工具耗时 |
|---|---|---:|---:|---:|---:|---:|---:|
| 1 | `session-0017feef-9d81-4c1e-99e9-fd77e2484671` | 76,251 | 264 | 3 | 3（`pwsh` / `glob` / `read`） | 4,646 ms | 762 ms |
| 2 | `session-6417d238-5c3e-4cb2-8a1f-88ae103b4370` | 76,055 | 175 | 3 | 2（`glob` / `read`） | 3,905 ms | 591 ms |
| 平均 | | **76,153** | **219.5** | **3** | **2.5** | **4,276 ms** | **677 ms** |

输入 token = `uncachedInputTokens + cacheReadTokens`。

### 实验组（插件开启）

| # | 会话 ID | 输入 token | 输出 token | step | 工具调用 | LLM 耗时 | 工具耗时 |
|---|---|---:|---:|---:|---:|---:|---:|
| 1 | `session-41408faa-6b5c-488e-be35-69730ea691bd` | 25,390 | 5 | 1 | 0 | 922 ms | 0 |
| 2 | `session-b33bca05-33be-4f25-9559-6cfb12d05f4d` | 25,558 | 37 | 1 | 0 | 1,072 ms | 0 |
| 平均 | | **25,474** | **21** | **1** | **0** | **997 ms** | **0** |

### 变化

| 指标 | 变化 |
|---|---:|
| 输入 token | −66.5% |
| 输出 token | −90.4% |
| 总 token | −66.6% |
| LLM step | −66.7% |
| 工具调用 | −100% |
| LLM 耗时 | −76.7% |
| 工具耗时 | −100% |

### 清掉测试问句后的复验

把测试时误落卡的问句清掉后，卡里只剩“暗号”这一条事实，再用同一个问题复验一次：

| 会话 ID | 输入 token | 输出 token | step | 工具调用 | LLM 耗时 |
|---|---:|---:|---:|---:|---:|
| `session-8d56ff00-2ab9-4c38-923a-055f63894384` | 25,363 | 6 | 1 | 0 | 971 ms |

这次保护带从 245 字降到 201 字（约 134 token），答案仍然是“蓝鲸七号。”，
没有读文件、没有调工具。它不在上面的 n=2 平均值里，只作为最终构建的冒烟复验。

## 注入成本

实验组实际注入块：

- 保护带：245 字。内容是项目暗号那条记忆 + 一句“能直接回答就别再读文件”的页脚。
  测试时卡里还留着一条历史问句；清掉后同一张卡的保护带是 201 字 / 约 134 token。
- 相关召回：0 字（暗号在 24 小时保护带里，不重复召回）。
- `memory_band` 工具 schema：`toolsTokens` 从 16,725 变为 16,856，约 +131 token。

也就是说，它用 **245 字 + 131 token 的工具 schema**，换掉了：

- 2 个额外的 LLM step；
- 2~3 次工具调用（列目录、搜索、读文件）；
- 工具结果回灌；
- 模型“总结我查到了什么”的输出 token。

## 模型实际做了什么

实验组两次都只用了 1 个 step，直接回答“蓝鲸七号”。

基线两次都是 3 个 step：先列目录 / 全局搜索，再读 `notes.md`，最后回答。基线也答对了，
但答案来自现场读取；实验组的答案来自已经注入的保护带。

会话事件里的注入块（实验组）：

```text
Current runtime context. This snapshot supersedes earlier runtime-context snapshots.

【记忆带 · 最近 24 小时（本地记忆，自动带入）】

## 最近 24 小时（记得最清楚）
- 11-02 18:50 DSH 记忆带实测暗号：蓝鲸七号。项目目录是 ...\dsh-memory-band。

（这是本地记忆带自动带入的旧事，不是用户这轮说的话；如果这里已经能回答，
就直接回答，别再读文件或搜索；自然用，别照读，也别提“记忆带”。）
```

基线同一位置只有工作目录、时间、权限等常规 runtime context，没有记忆带。

## 重要口径

### 1. “输入 token”包含缓存读取

DSH 的 `tokenUsage` 口径是：

```text
uncachedInputTokens + cacheReadTokens + cacheWriteTokens
```

缓存读取通常比未命中便宜。上表的 66.5% 是**上下文处理量**的下降，不是账单金额的下降。
如果你的 provider 缓存价很低，金额节省会小于这个数；但 step 数、工具往返、LLM 耗时
的下降是实测的。

### 2. 不是每次都能省

模型有随机性。测试中也出现过：即使记忆带里已经有答案，模型仍然先 `pwsh` 列目录、
再 `read` 文件，最后才回答。那一次实验组用了 3 个 step，输入 78,003 token，和基线接近。

为了提高“直接用记忆”的概率，插件的默认页脚明确写了：

> 如果这里已经能回答，就直接回答，别再读文件或搜索。

这句话不是保证，只是把默认行为往“先看记忆”推。对“某个文件里的某一节”这类问题，
模型天然更愿意查文件；记忆带在这里是兜底，不是替代。

### 3. 失败/回退

- 记忆卡为空：不注入，不会增加成本。
- 检索异常：返回空串，绝不让记忆把回复搞挂。
- 想完全回到“无记忆注入”：关闭 bundle，或把 `protectionBand.enabled` 设为 `false`
  且 `recallBand.impFloor: 0`。

## 复现

1. 准备 `bench/fixture/notes.md`（已在仓库里）。
2. 安装插件并写入一条记忆：

   ```text
   memory_band(action="remember",
     text="DSH 记忆带实测暗号：蓝鲸七号。项目目录是 ...\\dsh-memory-band。",
     importance=90)
   ```

3. 新建会话，cwd 指向 `bench/fixture`，发送问题，等 `turn/end`。
4. 在会话的 `projections.values.tokenUsage` / `sessionStats` 里读输入、输出、step、工具耗时。
5. 关闭插件（`pluginManager/setBundleEnabled` 或插件页开关），重复 3~4 作为基线。

> 测试机上的 DSH web 端口是 `127.0.0.1:53111`。不同机器以实际 URL 为准。
