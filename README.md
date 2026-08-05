<div align="center">

# 阶梯计划

**畅享丝滑 AI 学习**

一个以**疑问**为原子单位的学习工作台。

</div>

---

你问出的每一个问题，都不会白问。

AI 学习产品的通病是：内容生成得很丝滑，学完什么都没留下。阶梯把逻辑反过来——
课程、文档只是**内容的两种入口**，真正沉淀下来的是你在学习过程中产生的**问题卡片**。
它们连成链、织成图，最后成为只属于你、别处拿不到的**个人认知地图**。

## 三分钟了解

| 模块 | 一句话 |
|---|---|
| **课程** | 给个主题，AI 生成大纲，逐节懒生成讲解；长连接流式，不卡不崩 |
| **卡片** | 在正文**或 AI 的回答里**划词，就地浮出卡片；卡片里再划词，无限套娃 |
| **双图谱** | 概念图讲「这个领域该怎么学」，问题图讲「你是怎么想的」，进度图讲「你啃到哪了」 |
| **第二大脑** | 只回答你自己学过的东西，答案可溯源到原始卡片；记忆网络可视化 |
| **复习** | FSRS 间隔重复，快忘的卡自己浮出来；出题、判分、重排程全自动 |
| **文档** | PDF / EPUB / arXiv 导入，段落级对照翻译，同样能划词建卡 |

## 卡片系统：产品的灵魂

传统 chat 是一维时间线，卡片是二维空间。四条铁律，一条不让：

```
正文：……通过 softmax 归一化后得到权重分布……

① 划中「softmax」        → 就地浮出卡片 C1
② 在 C1 的回答里划「归一化」→ 生成子卡 C2，两卡之间自动连线
③ C2 答案里还有不懂的     → 再划 → C3 …… 可无限套娃
④ C1 C2 C3 同屏可见，原文始终没有被关闭、覆盖、顶走
⑤ 回看这条链：「我真正卡住的是归一化，不是 softmax」
```

1. **AI 的回答里必须也能划词建卡**——否则就退化成了普通多轮对话
2. **多张卡同时可见**——换内容就等于退回一维 chat
3. **卡与卡之间有可见连线**——没有线就看不出思维轨迹
4. **原文永远不被遮挡**——遮住原文就没人愿意用卡片了

卡片套娃天然产生 `1 / 1a / 1a1 / 1a1b` 的编号结构。链追得深了，
系统会反问一句：**要不要把这个疑问链提炼成一节专项课？**——从问题反向驱动课程生成。

## 双图谱：两张图，两种人格

- **概念图**（客观）：AI 从正文抽出的领域结构。`前置` 关系撑起分层，**上→下就是学习顺序**。
  数据本身不是树，也不该砍成树——多前置、跨概念的关联都是真实知识，保留图、只排层。
- **问题图**（主观）：你的卡片和追问链。**左→右是你钻研的深度**，每棵追问树独立生长；
  跨树的 `real link` 用琥珀色大弧线飞越结构——意外关联是第二大脑里最值钱的东西。
- **进度图**（叠加）：同一个领域结构，叠上你的学习状态。空心球 = 空白、蓝 = 提过问题、
  **绿 = 写过己见**（背过 ≠ 想过）。空白概念一键生成强化课。

## 第二大脑

> 我不会用通用知识给你兜底。检索不到就直说「你的学习记录里还没有涉及这部分」。

GraphRAG-lite 四路召回（jieba 全文 + 向量 + 图扩散 + 结构加权），RRF 融合后 LLM 重排。
**每次召回过程都会实时演在记忆网络上**——四路信号依次点亮、沿突触扩散，
你能亲眼看到它是怎么「想起来」的。

记忆网络的每个神经元是一张卡，不透明度来自 FSRS 记忆强度：**快忘掉的会自己淡下去**。
拖一下时间轴，可以回放你的知识网络从第一张卡长到今天的全过程。

## 快速开始

```bash
cp backend/.env.example backend/.env    # 填入 LLM API key
./start.sh
```

打开 <http://localhost:5173>，注册一个账号即可。

前置条件：**Node.js 18+** 和 [uv](https://docs.astral.sh/uv/)（自动装 Python 3.12）。
不需要 Docker，不需要单独装数据库——SQLite 单文件就是整个数据库。

## 部署到服务器

```bash
git clone https://github.com/nuronly/Ascend.git ladder && cd ladder
sudo ./install.sh     # 裸机：uv + systemd + Nginx，不需要 Docker
# 或
./deploy.sh           # 容器：Docker Compose + Caddy 自动 HTTPS
```

- 支持**域名 + HTTPS** 和**只有 IP** 两种模式，脚本自动识别并配置
- 已有手工配的 HTTPS 不会被覆盖；GitHub 拉不通自动退镜像；Node 损坏自动重装
- 更新一条命令：`sudo ./update.sh`
- 阿里云 ECS 逐步操作与故障排查：[`DEPLOY.md`](DEPLOY.md)

三个硬约束，提前知道能省一晚上：

1. **Serverless 走不通**——大纲 ~90 秒、正文 ~70 秒的 SSE 长连接，超过所有平台的超时上限
2. **Nginx 必须 `proxy_buffering off`**——漏了就是「卡住一分钟然后内容全部涌出」（脚本已配好）
3. **上线前先配成本闸**——别人用你的 key 花你的钱。`ALLOW_REGISTRATION` / `INVITE_CODE` /
   `MAX_USERS` / `DAILY_TOKEN_QUOTA` / `RATE_LIMIT_ENABLED`，至少开一道

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | React + TypeScript + Vite + Tailwind v4 |
| 卡片画布 | React Flow · 自定义节点即卡片 |
| 图谱 | Cytoscape.js + dagre 分层布局 |
| 记忆网络 | Canvas 2D 手绘（深浅底双调色板） |
| 后端 | FastAPI + Python 3.12 + SQLAlchemy 2.0 async |
| 数据库 | SQLite 现在 / PostgreSQL + pgvector 切换只改一行 |
| 检索 | jieba + FTS5 · 向量 · 图扩散 · RRF 融合 |
| 间隔重复 | FSRS |
| 鉴权 | argon2id + JWT httpOnly cookie |

LLM 走 provider 抽象层 + 分级路由：大纲用旗舰、正文用中档、打标用小模型；
主模型失败自动降级、可跨供应商；正文与 embedding 按内容 hash 缓存，同一段文本永不重复付费。
每次调用都记账，「设置 → AI 用量」随时可查。

## 验证

```bash
cd frontend && npm test                        # 67 项：渲染 / XSS / 流式半截内容 / 布局 / 配色对比度
cd backend && .venv/bin/python -m pytest       # JSON 截断修复等边界
cd backend && .venv/bin/python scripts/smoke.py  # 端到端冒烟（真实调 LLM，约 5 分钟）
```

测试里钉的都是踩过的真实坑：

- react-markdown 用 `hasOwnProperty` 查组件——值是 `undefined` 也照取，
  每个 `<p>` 变成 `createElement(undefined)` 整页白屏
- 大纲被 max_tokens 截断就整份报废——现在有括号栈修复器，救回前面完整的章节
- 配色里写了 `var(--x)`，而 cytoscape 走 Canvas 渲染根本解析不了 CSS 变量
- 空白节点与背景只差 5% 亮度，一张全是空白概念的图集体隐形

## 项目结构

```
backend/
  app/
    core/       配置 · 数据库 · ★ 数据隔离（UserScope 逐跳校验）
    llm/        ★ provider 抽象层 · 分级路由 · 降级 · 缓存 · 成本日志
    models/     ★ 全量 schema（一次埋齐，历史数据补不回来）
    services/   course · card · brain · review · prompts
    api/        HTTP 接口 · SSE
  scripts/      smoke.py · preflight.py · check_providers.py · backup.py
  tests/
frontend/
  src/
    components/ CardNode ★ · CardSpace ★ · useSelection ★ · NeuralNetwork
    lib/        graphLayout · graphTheme · neural · streamingMarkdown
    pages/      Section ★（原文+卡片分栏） · Graph · Brain · Vault · Review …
install.sh      裸机部署（systemd + Nginx，防 HTTPS 被覆盖、Node 失效自愈）
update.sh       一键更新（GitHub 不通自动退镜像，本地改动自动暂存恢复）
```

## 设计原则

- **界面灰阶，语义上色**——全局克制的灰阶，颜色只用来编码语义
  （real/potential、己见/AI 原生、空白/提过/有己见）。图谱统一浅底 + 彩色球。
- **数据不做绑架**——JSON 全量导出；Markdown zip 按 Luhmann 编号命名、
  双链写成 `[[编号]]`，直接扔进 Obsidian 就能用。
- **不静默编造**——降级链全挂就明确报错；残缺大纲会告诉你「这份大纲不完整」，而不是假装成功。
- **己见率 > 学习时长**——AI 一键生成的卡本质是摘抄堆积。入库前鼓励用自己的话改一句，
  改过的卡在图上有不同标记。这是比打卡时长诚实得多的深度指标。

## 状态

**已完成**：v0.1 卡片核心闭环 · v0.2 双图谱 · v0.3 文档模式 · v0.4 第二大脑 + FSRS · v0.5 勋章墙

**进行中**：Workspace 草稿画布前端界面（后端 API 已就绪）· 扫描件 PDF 的 OCR

---

<div align="center">
课程与文档只是两种投喂内容的入口。<br>
<b>你的问题，才是产品。</b>
</div>
