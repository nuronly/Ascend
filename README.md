# 阶梯

> 一个以**疑问**为原子单位的学习工作台。

课程与文档只是两种投喂内容的入口；**卡片是唯一的核心交互**。
学习行为（番茄）、认知结构（双图谱）、长期记忆（第二大脑）都建立在卡片之上。

> 文中多处标注的「设计文档 §x」指向一份未公开的产品计划文档，
> 记录了每个决策的取舍依据。相关结论已在注释与本文中说明，不影响阅读。

---

## 快速开始（本地）

```bash
cp backend/.env.example backend/.env    # 填入 API key
./start.sh
```

打开 http://localhost:5173 ，注册一个账号即可。

前置条件：**Node.js 18+** 和 [**uv**](https://docs.astral.sh/uv/)（会自动装 Python 3.12）。
不需要 Docker，不需要单独安装数据库。

---

## 上线

```bash
git clone https://github.com/nuronly/Ascend.git ladder && cd ladder
./deploy.sh
```

脚本会检查环境、引导填配置、构建、启动并自检。
支持两种模式：**有备案域名**（Caddy 自动申请 HTTPS）或**只有 IP**（纯 HTTP 先跑起来）。

阿里云 ECS 的逐步操作、以及各类故障的排查，见 [`DEPLOY.md`](DEPLOY.md)。

三个诊断脚本：

```bash
docker compose exec app python scripts/preflight.py       # 上线配置自检
docker compose exec app python scripts/check_providers.py # 逐路实测每个模型
bash backend/scripts/check_gates.sh                       # 验证准入与限流
```

### 三个绕不开的约束

**① Serverless 平台走不通。** 大纲生成约 90 秒、正文约 70 秒，全是 SSE 长连接。
Vercel Functions 免费版 10 秒超时、Pro 60 秒，Cloudflare Workers 更短。
后端必须跑在长连接友好的环境（VPS / 容器 / 传统云主机）。

**② 成本是最大风险，不是技术。** 多用户 + 云 API = **别人用你的 key 花你的钱**。
所以有三道闸，公开上线时至少开一道：

| 闸门 | 配置 |
|---|---|
| 关闭注册 | `ALLOW_REGISTRATION=false` |
| 邀请码 | `INVITE_CODE=...` |
| 人数上限 | `MAX_USERS=20` |
| 每人每日额度 | `DAILY_TOKEN_QUOTA=400000` |
| 速率限制 | `RATE_LIMIT_ENABLED=true` |

**③ 反代必须关缓冲。** 用 Caddy 是因为它**默认不缓冲**，SSE 开箱即用。
若改用 Nginx，必须显式 `proxy_buffering off;` —— 漏了就会出现
「卡住一分钟然后内容突然全部涌出」，而且极难排查。

### 部署形态

单体镜像：后端同时提供 API 和前端静态文件。一个容器、一个域名、
零 CORS、零跨域 cookie 问题。SPA fallback 已处理，刷新任意深层路由都正常。

⚠️ **SQLite 只能单 worker**（多进程写会锁竞争）。需要多 worker 时：

```bash
docker compose --profile pg up -d
# 然后把 .env.prod 的 DATABASE_URL 改成 postgresql+asyncpg://...
```

数据库和勋章图片都在 `ladder-data` 卷里，重建容器不会丢。

---

## 它和「又一个 AI 学习网站」的区别

| 常见做法 | 本产品 |
|---|---|
| AI 生成大纲 → 长文本讲解 | 同左，但**讲解只是卡片的产生场景** |
| 知识图谱 = AI 从大纲抽取 | **双图谱**：AI 客观图 + 用户主观问题图，且**可叠加** |
| 收藏夹 / 笔记本 | 灵感仓库 + FSRS 主动复活，拒绝坟场 |
| 通用 RAG 文档问答 | **只吃自己学过的东西**，答案可溯源到原始卡片 |

核心资产是**用户的卡片网络**——别处拿不到、也无法迁移复制的个人认知地图。

---

## 卡片系统：四条不可妥协的交互铁律

这是整个产品的灵魂，不是「划词问 AI」的小功能。
与传统 chat 的本质区别：**传统 chat 是一维时间线，卡片是二维空间。**

```
正文：……通过 softmax 归一化后得到权重分布……

① 划中「softmax」        → 就地浮出卡片 C1，自动带入选中词 + 所在句 + 小节标题
② 在 C1 的回答里划「归一化」→ 生成 C2，它是 C1 的子卡，两者之间自动连线
③ C2 答案里还有不懂的     → 再划 → C3 …… 可无限套娃
④ 此刻 C1 C2 C3 同屏可见，连成一条链，原文始终没有被关闭 / 覆盖 / 顶走
⑤ 回看这条链：「我真正卡住的是归一化，不是 softmax」
```

| # | 铁律 | 违反的后果 | 实现位置 |
|---|---|---|---|
| 1 | **AI 的回答里必须也能划词建卡** | 只能在原文划 = 退化成普通多轮对话 | [`AnswerBlock`](frontend/src/components/CardNode.tsx) |
| 2 | **多张卡同时可见**，不是一个面板换内容 | 换内容 = 又变回一维 chat | [`CardSpace`](frontend/src/components/CardSpace.tsx) |
| 3 | **卡与卡之间有可见连线** | 没有线就看不出思维轨迹 | [`buildEdges`](frontend/src/components/CardSpace.tsx) |
| 4 | **原文永远不被遮挡** | 遮住原文 = 打断阅读，用户放弃使用卡片 | [`SectionPage`](frontend/src/pages/Section.tsx) 分栏布局 |

卡片的三种产生方式（都支持）：

| 划词位置 | 结果 |
|---|---|
| 原文 | 根卡（`origin=source_text`，挂在该小节下） |
| AI 回答 | 子卡（`origin=parent_answer`，自动连线） |
| 自己写的己见 | 子卡（`origin=parent_note`） |

---

## 从 Folium 借鉴的四点

参考 [Folium](https://xc-xinze.github.io/Folium/documentation.html)（Luhmann 卡片盒方法论实现）。
借鉴的是**机制设计**，不复制其文案与图示。

1. **real / potential 两层链接分离**
   AI 只能产生 `potential`（弱建议），只有用户点「提升」才变成 `real`。
   *用户的图永远是用户自己的图。* 且 potential **只围绕当前焦点卡显示**，不全局铺开——
   否则画布几天就变成噪音网。

2. **Workspace（临时画布）与 Vault（正式仓库）分离**
   关系不确定时先在草稿画布上画，`Apply` 之后才写入正式双链。先画，后提交。
   真实卡被删除时降级为无链接临时卡，不破坏已有的视觉推理。

3. **卡片要「处理过」，不是摘抄堆积**
   AI 一键生成的卡片，本质就是摘抄堆积。所以入库前有一道轻量确认动作，
   鼓励用自己的话改一句；改过的卡标记为**己见卡**，在图上有不同视觉标记。
   「己见率」是学习深度的真实指标，**比学习时长诚实得多**。

4. **编号即位置 + 索引提权**
   卡片套娃天然产生 `1 / 1a / 1a1 / 1a1b` 结构，编号长度即深度。
   链深 ≥ 4 时提示「提炼成索引卡？还是生成一节专项课程？」——
   这是**从卡片反向驱动课程生成**的闭环入口。

---

## 文档模式

**难点不在翻译，在切段。**

PDF 抽出来的文本天然是碎的：一行一个片段、跨页断句、双栏交错、连字符断词。
直接按行翻译只会得到一堆语义不完整的碎片。所以重点是把碎片重新拼回段落：

| 处理 | 说明 |
|---|---|
| 断词还原 | `informa-\ntion` → `information` |
| 中英拼接 | 中文之间不加空格，英文之间必须加 |
| 分栏检测 | 按词的中心 x 坐标判断双栏，分别抽取 |
| 噪音剔除 | 页码、孤立 URL 不进翻译队列 |
| 超长切分 | 按句子边界切开，避免单次翻译请求过大 |

> **arXiv 一律优先走 HTML 版**（`arxiv.org/html` → `ar5iv`），
> 切段质量比解析 PDF 好一个量级，PDF 只作兜底。

翻译**按段落文本 hash 缓存**：同一段文字（哪怕来自另一篇文档）只翻译一次。

⚠️ 许可证：**不用 PyMuPDF**（AGPL-3.0，对外提供网络服务就要开源全部代码），
改用 pdfplumber (MIT) / pypdfium2 (Apache) / python-docx (MIT) / ebooklib。

---

## 架构

```
┌─────────────────┐
│  第二大脑 chat   │  GraphRAG-lite，只吃本产品内的学习记录
└────────▲────────┘
         │ 消费全部结构化沉淀
┌────────┴────────┬──────────────┬─────────────┐
│    课程模式      │   双图谱视图  │   FSRS 复习  │
└────────┬────────┴──────▲───────┴──────▲──────┘
         │               │              │
    ┌────┴───────────────┴──────────────┴──┐
    │        卡片系统（核心）                │
    │  划词 → 卡片 chat → 套娃 → vault      │
    └────────────────┬──────────────────────┘
                     │
         ┌───────────┴──────────┐
         │ 番茄钟（学习行为计量层）│
         └──────────────────────┘
```

| 层 | 选型 |
|---|---|
| 前端 | React + TypeScript + Vite + Tailwind v4 |
| 卡片画布 | React Flow (xyflow) — 自定义节点即卡片 |
| 知识图 | Cytoscape.js — 布局算法全 |
| Markdown | react-markdown + KaTeX + Shiki + **rehype-sanitize** |
| 后端 | FastAPI + Python 3.12 |
| ORM | SQLAlchemy 2.0 (async) |
| 数据库 | **SQLite**（现在）/ PostgreSQL + pgvector（切换只改一行） |
| 检索 | jieba + FTS5 / tsvector · 图扩散 · 向量 · RRF 融合 |
| 间隔重复 | py-fsrs |
| 鉴权 | argon2id + JWT（httpOnly cookie） |

### 数据库：SQLite 现在，Postgres 随时

方言差异全部收敛在 [`core/types.py`](backend/app/core/types.py) 和 [`search/fts.py`](backend/app/search/fts.py)，
业务模型只写一套：

| 能力 | SQLite | PostgreSQL |
|---|---|---|
| 全文检索 | FTS5 + jieba | `tsvector` + GIN + jieba |
| 向量召回 | float32 BLOB + numpy 余弦 | pgvector + HNSW |
| JSONB | JSON1 | JSONB |

切换方式：

```bash
# backend/.env
DATABASE_URL=postgresql+asyncpg://ladder:ladder@localhost:5432/ladder
```
```bash
cd backend && uv sync --extra postgres
```

> ⚠️ 表结构按设计文档 §5 **一次埋齐**，没有因为用 SQLite 就打折。
> 这是全计划里风险等级最高的一条：字段现在不埋，第二大脑就无米下炊，
> 而且**历史数据永远补不回来**。

---

## LLM：provider 抽象层 + 分级路由

业务代码只依赖 [`app/llm`](backend/app/llm) 的接口，永不 import 具体供应商 SDK。
这不是过度设计——它直接决定了能不能做分级路由。

| 场景 | 档位 | 默认模型 | 理由 |
|---|---|---|---|
| 大纲生成 | 旗舰 | `qwen3.8-max` | 低频、一次性、质量决定整门课体验 |
| 小节正文 | 中档 | `qwen3.7-plus` | 量大、可接受略逊，不满意可重生成 |
| 卡片问答 | 中档 + 流式 | `qwen3.7-plus` | 高频交互，延迟比质量重要 |
| 概念抽取 / 打标 | 小模型 | `qwen3.7-flash` | 结构化小任务 |
| 第二大脑重排 | 小模型 | `qwen3.7-flash` | 只做相关性打分 |
| 第二大脑终答 | 旗舰 | `qwen3.8-max` | 质量直接决定产品可信度 |
| 向量 | — | `qwen3.7-text-embedding` (1024d) | 与 schema 对齐 |

全部在 `backend/.env` 里配置，改模型不动一行业务代码。

工程防护全部落在 [`llm/router.py`](backend/app/llm/router.py) 一层：

- **降级链** 主模型失败 → 备用模型 → 换供应商；都不行**明确报错，绝不静默编造**
- **流式降级的硬约束**：一旦已吐出内容就不再换模型，否则用户会看到两段拼接的答案
- **重试** 指数退避 + 抖动，区分可重试（429/5xx）与不可重试（400）
- **缓存** 小节正文 / embedding 按内容 hash 缓存，同一段文本永不重复付费
- **预算闸** 每用户每日 token 上限，超了拒绝
- **成本日志** 每次调用记 token / 耗时 / 场景 / 估算美元，第一天就记

查看用量：应用内「设置 → AI 用量」，或直接查 `ai_calls` 表。

---

## 数据隔离

多用户化的难点不是登录页，是**数据隔离不能漏**。
所有数据访问必须经过 [`UserScope`](backend/app/core/scope.py)：

- 每张表带 `user_id`，`scope.select()` 自动注入过滤
- 从属表（chapters / sections / card_messages…）沿外键**回溯校验 owner**
- **图遍历逐跳校验**：沿 `card_links` 走 1~2 跳时，link 自身 + 两端卡片三重校验。
  只靠 `link.user_id` 是不够的，一条脏数据就能把别人的卡拉进你的第二大脑
- 检索**先按 user_id 过滤再算相似度**（先 ANN 后过滤会漏召回且可能跨用户）
- 拿不到的资源一律 **404 而非 403**，不泄露存在性

穿透测试（用户 A 能否读到用户 B 的任意资源）已进冒烟测试，**19 项全绿**。

---

## 验证

### 前端渲染测试（快，无需 API）

```bash
cd frontend && npm test
```

Markdown 渲染是本产品最脆弱的一环——内容全部由 LLM 生成，而且**流式到达因而永远是半截的**。
31 项覆盖：基础语法 · 公式（含非法公式）· 代码块 · 引用角标 ·
**XSS 注入** · 逐字符喂入的流式半截内容 · 流式稳定化纯函数。

> 其中有一条「回归说明」测试，钉的是一个真实故障：
> 曾经写了 `p: onCitation ? Comp : undefined`，而 react-markdown 底层
> 用 `hasOwnProperty` 查组件——**key 存在就取值，哪怕值是 undefined**，
> 于是每个 `<p>` 都变成 `createElement(undefined)`，整页白屏。
> 后端 82 项全绿却完全没覆盖到，所以补了这组测试。

### 后端端到端（真实调用 LLM）

```bash
cd backend && .venv/bin/python scripts/smoke.py
```

走完一遍 v0.1 核心闭环（约 5 分钟，花费约 $0.07）：

```
1.  鉴权 · argon2id + JWT httpOnly cookie
2.  课程线 · 主题 → 大纲（流式）
3.  番茄钟 · 时间戳制
4.  小节懒生成 · SSE 流式 + 缓存命中
5.  ★ 卡片系统 · 四条铁律逐条验证
6.  状态机 draft → vault · 写入期抽取概念与摘要
7.  Folium 借鉴 · real / potential 两层分离
8.  第二大脑 · GraphRAG-lite 多路召回 + 带引用回答
9.  FSRS 主动复习 · 出题 → 判分 → 重排程
10. 番茄结束 · 卡片回顾
11. ★ 跨用户穿透测试
12. 数据无损导出
13. 成本与用量记账
```

---

## 设计系统

**界面灰阶，语义上色**——这不是审美偏好，是功能需求。

```
界面层（导航/卡片/表单）  → 纯中性灰阶，零彩色
内容层（正文阅读）        → 黑白 + 单一强调色
语义层（图谱/状态/关系）   → 允许色相，但限低饱和度
```

如果全局只用灰阶，双图谱会直接残废——它要同时区分 real/potential、
己见卡/AI 原生卡、到期/健康、孤岛卡、5 种关系类型，
只靠粗细虚实维度根本不够，而且对色弱反而更不友好。

其它约定：

- 正文 **16.5px / 行高 1.78 / 栏宽 72ch**（极简风最常见的错误是字太小）
- 卡片深度靠**尺寸递减 + 连线粗细 + 编号长度**表达，**不用颜色**（颜色留给语义层）
- 孤岛卡用**褪色**而非颜色表达腐烂
- 阴影只给浮层，且极淡——卡片要「浮在旁边」而非「压在上面」
- 深色模式不用纯黑 `#000`，正文不用纯白，长时间阅读会残影
- 图谱画布即使浅色模式下也是深底——**图谱是「另一个空间」**，
  视觉上的奇异感会强化「我在俯瞰自己的认知地图」的仪式感

---

## 数据可无损导出

用数据库做本体，但**必须提供无损导出**——不做数据绑架。

- **JSON**：全量结构，字段与库内一一对应
- **Markdown zip**：卡片按 Luhmann 编号命名，双链写成 `[[编号]]`，
  直接扔进 Obsidian 就能用，不需要任何转换脚本

---

## 目录

```
backend/
  app/
    core/       配置 · 数据库 · 方言适配 · 鉴权 · ★ 数据隔离
    llm/        ★ provider 抽象层 · 分级路由 · 降级 · 缓存 · 成本日志
    models/     ★ 全量 schema（一次埋齐）
    services/   course · card · brain · review · prompts
    search/     jieba 分词 · FTS5/tsvector 适配
    api/        HTTP 接口 · SSE
  scripts/
    smoke.py    端到端冒烟测试
frontend/
  src/
    components/
      CardNode.tsx      ★ 卡片本体（AI 回答可划词 = 铁律 1）
      CardSpace.tsx     ★ React Flow 画布（多卡同屏 + 连线 = 铁律 2/3）
      useSelection.ts   ★ 划词引擎（三处可划 + 锚点回跳）
      Markdown.tsx      渲染 + XSS sanitize + 按需代码高亮
      Pomodoro.tsx      番茄钟 + 结束回顾
    pages/
      Section.tsx       ★ 阅读区 + 卡片空间分栏（原文不被遮挡 = 铁律 4）
      Course/Home/Vault/Graph/Brain/Review/Settings
    lib/
      cardSpace.ts      卡片空间状态
      api.ts            HTTP + SSE 客户端
```

---

## 已实现 / 待实现

**已实现**

- v0.1 核心闭环：登录鉴权 · 主题→大纲→懒生成讲解 · 卡片空间（四条铁律）· draft→vault 状态机 · 灵感仓库 · 番茄钟绑定小节
- v0.2 双图谱：卡片图 · AI 概念图 · **叠加视图** · real/potential 两层 · workspace 草稿画布（后端）· 从空白处一键生成强化课
- v0.4 第二大脑：GraphRAG-lite 多路召回 + RRF + LLM 重排 + 带引用回答 · FSRS 主动复习（出题 → AI 判分 → 重排程）

- v0.3 文档模式：PDF / docx / epub / Markdown 上传，arXiv 与网页导入，
  段落级对照翻译（hash 缓存），文档内划词建卡（与课程模式共用卡片系统）
- v0.5 勋章墙：15 枚勋章，条件覆盖完成 / 深度 / 坚持 / 探索四类；
  异步生图（达成即上墙，图好了替换），失败时用确定性几何图案兜底

**待实现**

- Workspace 草稿画布的前端界面（后端 API 已完成）
- 扫描件 PDF 的 OCR（当前只处理有文本层的 PDF）
