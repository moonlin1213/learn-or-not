# LearnOrNot · 学不学

> 把你的教材放上来，剩下的交给我。

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A524-brightgreen.svg)](https://nodejs.org/)

**学不学**是一个本地优先（local-first）的自托管「教材私教」：上传一本教材（PDF / EPUB / DOCX / Markdown / TXT），AI 把它拆成结构化课程，然后陪你一节课一节课地学——课前引导、精读讲义、术语注释、课后测验批改、划词提问。云端大模型是你的「私教老师」；如果你本地还跑着陪伴 agent，它也可以来当你的老师。

零框架、零构建、零依赖地狱：Node 24 + 原生 SQLite + 手写 vanilla 前端。clone 下来，`npm install` 之后就能跑。

## 学习科学在里面

「学不学」不是套壳聊天框，每一环都踩在认知科学的点上：

- **间隔重复（艾宾浩斯遗忘曲线）**：完成课节自动按 +1 / 2 / 4 / 7 / 15 / 30 天排期复习，到点提醒，对抗遗忘最有用的方法就是「在快忘掉的时候捞一把」
- **主动回忆（Active Recall）**：每节课都有小测验（选择 + 简答），回忆比重看一遍的效果强得多——错题自动收录进错题本，按薄弱度组卷重考，连对两次才算真正掌握
- **精细加工（Elaboration）**：讲义由 AI 以第一人称老师的口吻重新讲一遍（不是抄书），术语逐个注释；读到任何句子划个线、写下你的感想，原文留下虚线留痕，点留痕随时回看当时的思考
- **检索练习 + 情境支持**：选中任何文字直接问老师，引用自动带入；长会话用「滑动窗口 + 滚动小结」，老师记得你们聊过的重点，但 token 不爆炸
- **持续反馈**：AI 批改简答题写评语；每周一键生成学习周报（学习曲线、薄弱主题、下周建议）

## 有趣的点

- **陪伴 agent 也能当老师**：本地跑的陪伴 agent（比如你的 AI 伴侣）可以直接当聊天老师——它以本色回答，对话还会进它自己的记忆，你在这边学的东西，它在它那边真的记得
- **Obsidian 沉淀**：一键把讲义、术语、划线感想、错题写成 Obsidian vault——课程地图 MOC、wiki-link 互联，你的第二大脑自动长出来
- **古埃及纸草卷美学**：埃及圣书体饰带、莎草纸质感、低饱和配色；看不顺眼？内置两套主题模板，CSS 变量随便换
- **番茄钟在顶栏**：专注计时、自动切休息、自动记录，学完一节课顺手攒一个番茄
- **⌘K 全文搜索**：全部教材的讲义、术语、划线、错题、问答，一个快捷键搜遍
- **「继续学习」**：书架和课程地图都记得你上次学到哪，回来接着走

## 自由 DIY

前端是**零构建**的原生三文件（`public/index.html` / `style.css` / `app.js`），改完刷新即生效：

- **换皮**：改 `style.css` 顶部 CSS 变量（色板/字体/圆角）；或新增主题——`app.js` 的 `THEMES` 数组登记一项 + `style.css` 抄一个 `[data-theme="xxx"]` 变量块（内置古埃及/莫兰迪/夜间三套），主题下拉自动认识
- **自定义 CSS snippets**：设置页直接贴 CSS，存数据库、启动注入，`git pull` 冲不掉
- **阅读排版**：字号、字间距滑杆自由调
- **接入你自己的 agent**：只需实现两个端点的 [Companion Contract](#接入你的陪伴-agentcompanion-contract)，30 行 shim 就够
- **注意**：DIY 请走源码模式（`npm start`）；打包的 Electron 应用用的是 asar 内置文件

## 特性一览

- **教材 → 课程**：上传教材或导入本地 Markdown 目录树，AI 研读后拆成模块与课节（大纲可重新规划）
- **四段式课节**：课前引导 → 精读讲义 → 术语卡 → 课后测验（选择+简答，AI 批改写评语）
- **课件朗读**：不想看字？点「▸ 朗读」，Edge TTS 免费神经音色（无需 key）把当前页签像讲课一样读出来——分段渐进合成、段间无缝，迷你播放条可暂停/停止；音色语速在设置页随便换
- **艾宾浩斯复习**：完成课节自动排期，到点提醒，复习页重做测验
- **错题本与重考**：错题自动收录，按薄弱度组卷重考，连对两次自动掌握
- **划线与感想**：读讲义时划句子、写感想；原文留下虚线留痕，点留痕随时回看
- **划词提问**：选中任何文字直接问老师，引用自动带入
- **双模型**：「主模型」负责备课批改，「聊天模型」在侧栏随时换——云端模型和本地陪伴 agent 随便挑
- **长会话滚动小结**：聊天窗口=最近 12 条原文，掉出窗口的旧消息攒批压成滚动小结，老师不健忘也不烧钱
- **会话恢复与防丢失**：关页、红叉隐藏或退出时自动把当前非空会话收入记录，同时保留为可续聊的当前会话；下次启动继续往同一张归档卡追加，绝不重复建卡。点圆圈「入」或黑猫才会封存它并开启新会话
- **Obsidian 沉淀**：一键写成 Obsidian vault（课程地图 MOC + wiki-link 互联）
- **番茄钟**：顶栏专注计时，完成自动记录、自动切休息
- **全文搜索**：⌘K 搜全部教材的讲义、术语、划线、错题、问答
- **数据备份**：全部学习数据一键导出/恢复 JSON
- **继续学习**：书架和课程地图都记得你上次学到哪
- **顶栏往返记忆**：点顶栏任何标签（术语卡/划线/错题本/设置…）都会记住来路，标签随即变成「‹ 返回」——再点一次，原路回到刚才的页面、刚才滚到的位置
- **AI 学习周报**：每周一键生成学习曲线分析、薄弱主题归纳与下周建议

## 快速开始

需要 **Node.js ≥ 24**（用到了内置的 `node:sqlite`）。

```bash
git clone https://github.com/moonlin1213/learn-or-not.git
cd learn-or-not
npm install
npm start          # 打开 http://127.0.0.1:3210
```

想要双击图标、不要浏览器（可选）：

```bash
npm run dist       # 产出未签名的 macOS 应用到 dist/（electron-builder --mac --dir）
```

第一次使用：到「设置」连接订阅账户，或手动添加一个 provider，然后回书架上传第一本教材。

## 模型配置（云端老师）

### Codex / Grok 订阅 OAuth

设置页「订阅账户」可以直接连接：

- **Codex**：使用 ChatGPT Plus / Pro 订阅，通过 OpenAI 官方 OAuth 登录。
- **Grok**：使用 SuperGrok / X Premium 订阅，通过 xAI 官方设备码登录。
- 已安装 DSH Everything OAuth 且本机已登录 Codex / Grok 时，启动和打开设置页会自动复用这份 OAuth 登录态，无需在「学不学」里重复授权；仅当本机没有可用登录态时才会走官方设备码登录。

访问令牌保存在数据目录的 `oauth-credentials.json`：文件权限固定为 `0600`，与 SQLite 学习数据库分离，不会进入 LearnOrNot 学习备份或 provider 接口响应。刷新、并发锁与 Codex 专用 Responses 协议由 `@earendil-works/pi-ai` 统一处理。「断开连接」会删除本机凭据；如需立即撤销仍在有效期内的服务端授权，请同时到对应账户的安全设置里撤销该应用。

### API Key provider

设置页手动添加 provider，三种协议覆盖几乎所有服务：

| 协议 | 适用 |
|---|---|
| `openai-completions` | OpenAI、DeepSeek、Moonshot、OpenRouter、各类中转网关、Ollama / LM Studio（OpenAI 兼容端点） |
| `openai-responses` | OpenAI Responses API 系 |
| `anthropic-messages` | Claude 及 Anthropic 兼容网关 |

填写示例：

```
名称:  DeepSeek 官方
协议:  openai-completions
URL:   https://api.deepseek.com/v1        # OpenAI 系必须自带 /v1
Key:   sk-...
模型:  deepseek-chat, deepseek-reasoner
```

- **主模型**（顶栏徽章）：设置页点模型 chip 设为默认，负责备课、批改、小结等所有系统调用
- **聊天模型**：聊天栏右上角随时换，选择会记住
- 如果你恰好是 DeepSeek Harness（DSH）用户，设置页会出现「从 DSH 导入」卡片，一键搬来全部 provider（检测不到 DSH 时该卡片自动隐身）

## 接入你的陪伴 agent（Companion Contract）

学不学可以把「老师」换成你本地跑的陪伴 agent——它以本色回答，你们聊的每句话都进它自己的记忆系统。任何 agent 系统只需满足两个端点的契约：

```
GET  {地址}{状态路径}                         → 2xx 即「在家」
POST {地址}{聊天路径}  {content, model_content}  → SSE 流：data: {"type":"chunk","content":"增量文本"}
```

- `content` = 用户的原话；`model_content` = 原话 + 学习上下文（在读哪本书哪节课、选中了什么原文），由 agent 自行决定是否使用
- 聊天路径支持 `{conv}` 占位（多会话型 agent 用来指定投递会话）
- 不满足契约？在你 agent 那边写个 ~30 行的 shim 翻译一下即可，学不学这边零改动

设置 →「陪伴 agent」填名字和地址即可；内置**本地实例预设**（一键填参 + 会话自动发现）。完整契约见 [docs/companion-contract.md](docs/companion-contract.md)。

## 数据与配置

| 内容 | 位置 |
|---|---|
| 全部学习数据 | `data/learnloop.db`（SQLite，已被 .gitignore） |
| 迁移/换机 | 设置 → 数据备份，导出/恢复 JSON（含教材正文与原书文件） |
| 端口 | 默认 3210，`PORT` 环境变量可改 |
| 数据目录 | `LEARNLOOP_DATA_DIR` 环境变量，或 `local.config.json` 的 `dataDir` |
| 代理 | `local.config.json` 的 `proxy`（默认不设代理） |
| 沉淀目录 | 设置页可配；或 `LEARNLOOP_HANLIN_DIR` 环境变量 |

`local.config.json`（已被 .gitignore）放在项目根或应用 userData 目录：

```json
{ "proxy": "http://127.0.0.1:7897", "dataDir": "/abs/path/to/data" }
```

## 架构速览

```
server/    node:http 零框架 API + node:sqlite + busboy 上传
  parser.js     PDF/EPUB/DOCX/MD/TXT 解析
  pipeline.js   拆课、备课、批改、滚动小结、周报（所有 LLM 调用单轮无状态）
  llm.js        三种协议适配器
  companion.js  陪伴 agent 适配器（Companion Contract 参考实现）
  exporter.js   翰林院 Obsidian 沉淀
public/    零构建 SPA：hash 路由 + 迷你 markdown 渲染器 + KaTeX
electron/  可选桌面壳（复用 3210 上已运行的后端，否则自起）
```

设计要点：所有 LLM 调用都是**单轮**（历史拼进单条消息），兼容最挑剔的网关；聊天长会话用「滑动窗口 + 攒批滚动小结」控制 token；前端无构建、无框架，想怎么改就怎么改。

## License

LearnOrNot 的原创代码采用 [GNU Affero General Public License v3.0 only](LICENSE)（`AGPL-3.0-only`）授权。

如果你修改本程序，并通过网络让用户与修改后的版本交互，你必须向这些用户提供该版本的对应源代码。仓库中的第三方组件、字体和其他素材仍分别适用其自身许可证或授权条款。

随源码分发的第三方组件与字体清单见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

贝斯特猫与翼形圣甲虫图像是项目作者原创的品牌资产，来源说明见 [BRAND_ASSETS.md](BRAND_ASSETS.md)。AGPL 软件许可不授予项目名称或品牌标识的商标权。
