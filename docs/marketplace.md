# 上架到 DSH 插件市场

这个包已经按 DSH bundle 的安装约定准备好：

```text
package.json          dsh.bundle.patch -> cordis.patch.yml
cordis.patch.yml      id: dsh-memory-band, name: ./lib/index.js
lib/index.js          Cordis 入口（name / inject / apply）
engines.dsh           >= 0.2.0
README.md             市场详情页正文
assets/icon.svg       卡片图标
assets/band.svg       README 横幅
docs/marketplace-entry.json  awesome-dsh-plugin 条目
site/index.html       独立主页
```

## 1. 发布包

```sh
npm publish --access public
```

发布前确认：

```sh
npm pack --dry-run
node --test --test-isolation=none
```

`files` 已包含 `lib`、`src`、`docs`、`assets`、`site`、`README.md`、
`cordis.patch.yml`，不会把测试/夹具/CI 临时文件带进包里。

## 2. 提交到 curated registry

dsh-market 的列表来自 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，
不是 dshmarket 仓库本身。到该仓库提一个 PR，加入一条条目（字段以仓库当时 schema 为准）：

```json
{
  "name": "dsh-memory-band",
  "owner": "13576751971",
  "url": "https://github.com/13576751971/dsh-memory-band",
  "category": ["memory", "productivity"],
  "description": {
    "en": "Local three-band memory for DeepSeek Harness: a 24h protection band, query recall and scene replay, auto-injected into every session without embedding or model calls.",
    "zh": "给 DeepSeek Harness 的本地三段式记忆带：24 小时保护带、按话题召回、场景回放，自动注入每个会话；不调模型、不建向量库。"
  },
  "npm": "dsh-memory-band",
  "install": "dsh plugin --profile <profile> add dsh-memory-band"
}
```

`docs/marketplace-entry.json` 是同一份内容的可复制文件。

## 3. 市场里用户看到什么

- **卡片标题**：来自 `package.json.name`
- **一句话描述**：来自 `description` / registry 的 `description.zh`
- **详情页正文**：本仓库 `README.md`
- **图标**：registry 的 `icon`（当前指向 `assets/icon.svg`）
- **截图**：市场会从 README 提取图片；`assets/band.svg` 是首图
- **安装来源**：优先 npm，其次 GitHub

## 4. 版本与兼容

- 当前 `0.2.2`，要求 DSH `>= 0.2.0`（`engines.dsh`）。
- 升级版本时同步改 `package.json.version` 和 `lib/index.js` 的 `version`。
- 如果 DSH 未来改变 `systemPrompt.context` / `tools.register` 契约，先跑
  `test/bundle.test.mjs` 的假 ctx 契约测试，再在真机测一次。

## 5. 市场安装冒烟检查

在 DSH 里装好后：

1. `Plugins` 里能看到 `dsh-memory-band`，开关为开；
2. 新会话的 runtime context 里出现 `【记忆带 · 最近 24 小时】`；
3. 工具列表里有 `memory_band`；
4. `GET http://127.0.0.1:<port>/dsh-memory-band/health` 返回 `ok: true` 和记录条数；
5. 对助理说“记住：项目暗号是TEST-CODE-7F3A”，刷新新会话，问“项目暗号是什么”，
   它应直接回答，而不是先读文件。
