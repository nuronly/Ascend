import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { SelectionDemo } from '@/components/SelectionDemo'
import { useAuth, useTheme } from '@/lib/store'
import { cn } from '@/lib/utils'

/**
 * 使用说明。
 *
 * 这一页存在的理由：本产品的核心动作「划词建卡」在界面上是**不可见**的
 * —— 没有按钮、没有菜单、没有右键项。不解释就永远不会被发现。
 *
 * 风格沿用阅读区：极简学术风，窄栏、大留白、灰阶为主。
 * 不用营销腔 —— 读这个的人是来学怎么用的，不是来被说服的。
 */

const SECTIONS = [
  { id: 'idea', label: '这是什么' },
  { id: 'card', label: '卡片：核心动作' },
  { id: 'nest', label: '套娃：往深处追问' },
  { id: 'note', label: '己见：让卡片属于你' },
  { id: 'vault', label: '仓库与复习' },
  { id: 'graph', label: '图谱' },
  { id: 'brain', label: '第二大脑' },
  { id: 'doc', label: '文档模式' },
  { id: 'pomodoro', label: '番茄钟' },
  { id: 'badge', label: '勋章' },
  { id: 'tips', label: '小技巧' },
  { id: 'why', label: '为什么这么设计' },
]

function H({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2
      id={id}
      className="scroll-mt-20 text-[19px] font-semibold tracking-[-0.015em] mt-14 mb-3 first:mt-0"
    >
      {children}
    </h2>
  )
}

function P({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn('text-[15px] leading-[1.8] mt-3.5', className)}>{children}</p>
}

function Muted({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[13.5px] leading-[1.75] mt-3 text-[var(--text-muted)]">{children}</p>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center h-[19px] px-1.5 mx-0.5 rounded-[4px] border border-[var(--border-strong)] bg-[var(--bg-sunken)] font-mono text-[11.5px] align-baseline">
      {children}
    </kbd>
  )
}

/** 行内示意：一个被选中的词 */
function Sel({ children }: { children: React.ReactNode }) {
  return (
    <span className="px-1 py-[1px] mx-0.5 rounded-[3px] bg-[color-mix(in_oklch,var(--accent)_22%,transparent)] font-medium">
      {children}
    </span>
  )
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3.5">
      <span className="shrink-0 mt-[3px] size-[22px] flex items-center justify-center rounded-full bg-[var(--bg-active)] text-[12px] font-semibold tabular-nums">
        {n}
      </span>
      <div className="min-w-0">
        <div className="text-[14.5px] font-medium">{title}</div>
        <div className="text-[13.5px] leading-[1.75] text-[var(--text-muted)] mt-1">
          {children}
        </div>
      </div>
    </li>
  )
}

/** 套娃链条示意图 */
function NestDiagram() {
  const items = [
    { id: '1', term: 'softmax', from: '在正文里选中' },
    { id: '1a', term: '归一化', from: '在上一张卡的回答里选中' },
    { id: '1a1', term: '概率分布', from: '再往下一层' },
  ]
  return (
    <div className="mt-5 space-y-0">
      {items.map((it, i) => (
        <div key={it.id} className="flex gap-3">
          <div className="flex flex-col items-center shrink-0">
            <div
              className="size-2 rounded-full bg-[var(--accent)] mt-[15px]"
              style={{ opacity: 1 - i * 0.22 }}
            />
            {i < items.length - 1 && <div className="w-px grow bg-[var(--border-strong)]" />}
          </div>
          <div
            className="mb-2.5 px-3 py-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-raised)]"
            style={{ width: `${100 - i * 7}%`, marginLeft: `${i * 14}px` }}
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10.5px] text-[var(--text-subtle)]">{it.id}</span>
              <span className="text-[13px] font-medium text-[var(--accent)]">⟨{it.term}⟩</span>
            </div>
            <div className="text-[11.5px] text-[var(--text-subtle)] mt-0.5">{it.from}</div>
          </div>
        </div>
      ))}
      <Muted>
        编号的长度就是深度。<code className="font-mono text-[12.5px]">1a1</code>{' '}
        表示这是第三层 —— 借用的是卢曼卡片盒的编号法。
      </Muted>
    </div>
  )
}

export default function GuidePage() {
  const nav = useNavigate()
  const user = useAuth((s) => s.user)
  const { theme, setTheme } = useTheme()
  const [active, setActive] = useState('idea')

  // 滚动高亮当前章节
  useEffect(() => {
    const obs = new IntersectionObserver(
      (entries) => {
        const hit = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        if (hit) setActive(hit.target.id)
      },
      { rootMargin: '-72px 0px -70% 0px' },
    )
    SECTIONS.forEach((s) => {
      const el = document.getElementById(s.id)
      if (el) obs.observe(el)
    })
    return () => obs.disconnect()
  }, [])

  return (
    <div className="min-h-full bg-[var(--bg)]">
      {/* 顶栏 */}
      <header className="sticky top-0 z-30 h-12 flex items-center gap-3 px-5 border-b border-[var(--border)] bg-[var(--bg)]/92 backdrop-blur-sm">
        <button
          onClick={() => nav(user ? '/' : '/login')}
          className="flex items-center gap-2 text-[13px] font-medium hover:opacity-70 transition-opacity"
        >
          <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
            <path d="M4 19h5v-5" />
            <path d="M9.5 14h5V9" />
            <path d="M15 9h5V4.5" />
          </svg>
          阶梯
        </button>
        <span className="text-[var(--border-strong)]">/</span>
        <span className="text-[13px] text-[var(--text-muted)]">使用说明</span>

        <div className="grow" />

        <button
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          className="size-7 flex items-center justify-center rounded-[var(--radius)] text-[var(--text-subtle)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
          title="切换主题"
        >
          <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
            <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
          </svg>
        </button>

        <Link
          to={user ? '/' : '/login'}
          className="h-7 px-3 flex items-center rounded-[var(--radius)] bg-[var(--accent)] text-[var(--accent-text)] text-[12.5px] font-medium hover:bg-[var(--accent-hover)] transition-colors"
        >
          {user ? '回到学习' : '开始使用'}
        </Link>
      </header>

      <div className="max-w-[1000px] mx-auto px-6 lg:px-8 flex gap-12">
        {/* 侧边目录 */}
        <nav className="hidden lg:block w-[176px] shrink-0 pt-14">
          <div className="sticky top-[72px]">
            <div className="text-[11px] text-[var(--text-subtle)] mb-2.5">目录</div>
            <ul className="space-y-0.5 border-l border-[var(--border)]">
              {SECTIONS.map((s) => (
                <li key={s.id}>
                  <a
                    href={`#${s.id}`}
                    className={cn(
                      'block py-1 pl-3 -ml-px border-l text-[12.5px] transition-colors',
                      active === s.id
                        ? 'border-[var(--accent)] text-[var(--text)] font-medium'
                        : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text)]',
                    )}
                  >
                    {s.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </nav>

        {/* 正文 */}
        <article className="min-w-0 grow max-w-[664px] py-14 pb-32">
          <h1 className="text-[30px] font-semibold tracking-[-0.022em] leading-[1.25]">
            使用说明
          </h1>
          <p className="text-[15px] text-[var(--text-muted)] leading-[1.75] mt-3">
            读完大概三分钟。第二节是关键 —— 这个产品的核心动作在界面上没有按钮，
            不说你不会知道。
          </p>

          {/* ── 这是什么 ── */}
          <H id="idea">这是什么</H>
          <P>
            一个以<b>疑问</b>为单位的学习工作台。
          </P>
          <P>
            常见的 AI 学习工具是「生成一篇长文给你读」。问题在于，读长文时你会不断产生疑问，
            而每次去问 AI，上一段的语境就被冲掉了 —— 因为对话是一条<b>时间线</b>。
          </P>
          <P>
            这里换了个做法：你的每一个疑问都变成一张<b>卡片</b>，各自占据一块空间。
            追问不会顶掉之前的内容，而是在旁边长出新的一张。
            读完一节课，你会得到一张自己的问题网络 —— 那才是真正属于你的东西。
          </P>
          <div className="mt-5 pl-4 border-l-2 border-[var(--border-strong)]">
            <Muted>
              课程和文档只是两种投喂内容的入口。真正沉淀下来的是卡片。
            </Muted>
          </div>

          {/* ── 卡片 ── */}
          <H id="card">卡片：唯一需要学会的动作</H>
          <P>
            <b>用鼠标选中一个词</b>，就这么简单。像用荧光笔划重点那样，
            按住左键拖过去，松开。
          </P>

          <div className="mt-6 flex justify-center py-6 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-sunken)]">
            <SelectionDemo />
          </div>

          <ol className="mt-7 space-y-4">
            <Step n={1} title="选中不懂的词">
              在正文里拖选，比如 <Sel>softmax</Sel>。松开鼠标后，旁边会浮出一个
              「就这里提问」的按钮。
            </Step>
            <Step n={2} title="提问">
              点那个按钮。可以直接回车（默认问「这是什么意思」），也可以自己写问题。
            </Step>
            <Step n={3} title="卡片出现在右侧">
              AI 开始流式回答。<b className="text-[var(--text)]">左边的原文不会被遮挡</b> ——
              这是刻意的，遮住原文就打断阅读了。
            </Step>
          </ol>

          <Muted>
            双击选词、三击选整段也都可以。选中你自己写的文字同样有效。
          </Muted>

          {/* ── 套娃 ── */}
          <H id="nest">套娃：往深处追问</H>
          <P>
            这是整个产品最值钱的部分，也是最容易被忽略的：
            <b>AI 回答里的词，同样可以选中。</b>
          </P>
          <P>
            很多时候你以为自己卡在 A，追问两层才发现真正不懂的是 B。
            在回答里继续选词，会长出一张<b>子卡</b>，两张卡之间自动连线。
          </P>

          <NestDiagram />

          <P className="mt-6">
            回头看这条链，你会看到自己的思维轨迹：
            <span className="text-[var(--text-muted)]">
              「原来我真正卡住的是归一化，不是 softmax。」
            </span>
          </P>
          <div className="mt-5 px-4 py-3 rounded-[var(--radius)] border border-dashed border-[var(--border-strong)] bg-[var(--bg-sunken)]">
            <div className="text-[13px] leading-[1.75]">
              追问到第 5 层时，系统会提示你：这条链已经很深了，
              要不要把它提炼成一张索引卡，或者<b>直接生成一节专项课</b>？
            </div>
          </div>

          {/* ── 己见 ── */}
          <H id="note">己见：让卡片真正属于你</H>
          <P>
            每张卡上都有一个「✎ 我的话」输入框。
            AI 的回答再好，那也是 AI 的话 —— <b>用你自己的话重写一遍，这张卡才算你的。</b>
          </P>
          <P>
            写过己见的卡会被标记出来（绿色描边），并且在统计里单列一个指标：
            <b>己见率</b>。
          </P>
          <Muted>
            为什么强调这个：学习时长是可以刷的，卡片数量也可以刷，但「用自己的话
            重新表述一遍」骗不了人。己见率是这个产品里最诚实的指标。
          </Muted>

          {/* ── 仓库 ── */}
          <H id="vault">仓库与复习</H>
          <P>
            卡片刚建出来是<b>草稿</b>状态。觉得有价值就点「收进仓库」，
            它才会进入图谱、进入第二大脑、进入复习排程。
          </P>
          <P>
            这道筛选是必要的 —— 不筛的话，随口一问产生的垃圾卡很快会淹没真正重要的东西。
            番茄钟结束时会自动弹出本轮产生的卡片让你勾选，那是最自然的整理时机。
          </P>
          <P>
            进了仓库的卡会按<b>间隔重复</b>算法安排复习。到期时不是把原文再给你看一遍，
            而是<b>出一道题</b>让你回答，然后 AI 判分、据此重新排程。
          </P>
          <Muted>
            记住东西靠的是回想，不是重读。这也是为什么复习页不给你「看答案」按钮，
            而是逼你先写点什么。
          </Muted>

          {/* ── 图谱 ── */}
          <H id="graph">图谱</H>
          <P>这里有两张性质完全不同的图：</P>
          <div className="mt-4 space-y-3">
            {[
              ['AI 概念图', '这个领域客观上长什么样 —— 由 AI 从课程内容里抽取'],
              ['我的问题图', '你实际上是怎么想的 —— 由你的卡片和连线构成'],
            ].map(([t, d]) => (
              <div key={t} className="flex gap-3">
                <span className="mt-[7px] size-1.5 rounded-full bg-[var(--accent)] shrink-0" />
                <div>
                  <span className="text-[14px] font-medium">{t}</span>
                  <span className="text-[13.5px] text-[var(--text-muted)]"> —— {d}</span>
                </div>
              </div>
            ))}
          </div>
          <P className="mt-5">
            <b>叠加视图</b>把两者重合在一起，于是你能一眼看出：这个领域我啃过哪几块、
            哪几块<b>一个问题都没提过</b>。空白的地方可以一键生成强化课。
          </P>

          <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-[12.5px] text-[var(--text-muted)]">
            <span className="flex items-center gap-2">
              <span className="w-5 h-0 border-t-2" style={{ borderColor: 'var(--sem-real)' }} />
              关联：你亲手连的
            </span>
          </div>
          <Muted>
            卡片之间的连线只能由你亲手建立（从一张卡拖到另一张）。
            你的认知地图不允许 AI 乱画。
          </Muted>

          {/* ── 第二大脑 ── */}
          <H id="brain">第二大脑</H>
          <P>
            向它提问，它<b>只回答你自己学过的东西</b>。检索不到就直说「你的学习记录里
            还没有涉及这部分」，不会用通用知识给你兜底装懂。
          </P>
          <P>
            每句话后面都有可点击的引用角标，点开就是原始卡片。
          </P>
          <P>
            左边那张会发光的网络不是装饰：<b>每个亮点是一张卡，亮度就是你对它的记忆强度</b>。
            快忘掉的会自己暗下去，没有任何连接的「孤岛卡」几乎熄灭。
            提问时，你能看着四路检索在网络上依次点亮、信号沿着连接扩散 ——
            那就是它「想起来」的过程。
          </P>

          {/* ── 文档 ── */}
          <H id="doc">文档模式</H>
          <P>
            除了 AI 生成的课程，你也可以导入自己的材料：PDF、Word、EPUB、Markdown，
            或者直接粘贴一个 <b>arXiv 编号</b>（比如 1706.03762）。
          </P>
          <P>
            译文会紧贴在原文段落下方，段落级对照。
            读到不懂的地方，<b>照样选中提问</b> —— 和课程模式完全一样的卡片系统。
          </P>
          <Muted>
            arXiv 论文会自动走 HTML 版本，排版比解析 PDF 干净得多。
            扫描件（纯图片的 PDF）没有文字层，暂时读不了。
          </Muted>

          {/* ── 番茄钟 ── */}
          <H id="pomodoro">番茄钟</H>
          <P>
            它不是一个独立的计时器，而是学习行为的<b>计量单位</b>。
            进入小节时自动开始，默认时长可在「设置」里调整。
          </P>
          <P>
            这段时间里产生的卡片会自动归到这颗番茄名下。
            结束时不弹「休息一下」，而是把这些卡摊开让你挑：哪些值得留，哪些是随口一问。
          </P>

          {/* ── 勋章 ── */}
          <H id="badge">勋章</H>
          <P>
            条件不只看「学完多少」。完成类只是入场券，真正难拿的是<b>深度类</b>：
            己见率过半、单门课写够 8 张己见卡、追问链深达 5 层、手动建立 20 条关联。
          </P>
          <Muted>
            这些都是「你确实想过」的证据，刷不出来。
          </Muted>

          {/* ── 小技巧 ── */}
          <H id="tips">小技巧</H>
          <div className="mt-4 space-y-2.5">
            {[
              ['在自己写的己见里选词', '人常在自述时冒出新疑问，这时候接着追问最有效'],
              ['从一张卡拖到另一张卡', '手动建立关联，可以标注是延续、对照、证据、结果还是张力'],
              ['卡片太多时点标题栏折叠', '折叠后只剩一个小条，链再长也不会淹没屏幕'],
              ['正文顶部的「重讲」', '讲浅一点、讲深一点、换个例子、精简一些 —— AI 编课质量不稳，方向盘给你'],
              ['点原文里的下划线', '那是你划过的词，点它会跳到对应的卡片'],
              ['仓库里的「孤岛卡」', '长期没碰又没有任何连接的卡，定期清一清，别让仓库变成坟场'],
            ].map(([t, d]) => (
              <div key={t} className="flex gap-3">
                <span className="mt-[9px] size-1 rounded-full bg-[var(--text-subtle)] shrink-0" />
                <div className="text-[13.5px] leading-[1.7]">
                  <b className="font-medium">{t}</b>
                  <span className="text-[var(--text-muted)]"> —— {d}</span>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-3 text-[12.5px] text-[var(--text-muted)]">
            <span>
              <Kbd>Enter</Kbd> 提问
            </span>
            <span>
              <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> 换行
            </span>
            <span>
              <Kbd>Esc</Kbd> 取消选中
            </span>
            <span>
              <Kbd>双击</Kbd> 己见区可编辑
            </span>
          </div>

          {/* ── 为什么 ── */}
          <H id="why">为什么这么设计</H>
          <P>几条不太常见的取舍，说明一下理由：</P>

          <div className="mt-5 space-y-5">
            {[
              [
                '为什么不做成聊天框',
                '聊天是一条时间线，深挖一个概念会把上文顶走。卡片是二维的 —— 每张各占位置，追问的过程本身就在画图。',
              ],
              [
                '为什么 AI 不能自动连线',
                '如果 AI 能往图里加边，几天后你的图就会变成一张噪音网。所以连线永远由你亲手建立。',
              ],
              [
                '为什么逼你写「我的话」',
                'AI 一键生成的卡片，本质是摘抄堆积。摘抄不产生理解。改写一句，哪怕改得不好，也比原样收藏强得多。',
              ],
              [
                '为什么正文按需生成',
                '你随手输一个主题就跑几十次大模型，既慢又贵。所以先出大纲，点进哪一节才写哪一节，写过的会缓存。',
              ],
              [
                '为什么复习要出题',
                '重读会产生「我已经懂了」的错觉。回想不会。所以到期时给你的是一道题，不是原文。',
              ],
            ].map(([q, a]) => (
              <div key={q}>
                <div className="text-[14px] font-medium">{q}</div>
                <div className="text-[13.5px] leading-[1.75] text-[var(--text-muted)] mt-1">
                  {a}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-14 pt-7 border-t border-[var(--border)]">
            <P className="text-[var(--text-muted)]">
              你的卡片随时可以完整导出（Markdown 或 JSON）。
              Markdown 包里双链写成 <code className="font-mono text-[13px]">[[卡片名]]</code>，
              直接扔进 Obsidian 就能用。数据是你的。
            </P>
            <Link
              to={user ? '/' : '/login'}
              className="inline-flex items-center gap-1.5 h-9 px-4 mt-5 rounded-[var(--radius)] bg-[var(--accent)] text-[var(--accent-text)] text-[13.5px] font-medium hover:bg-[var(--accent-hover)] transition-colors"
            >
              {user ? '回到学习' : '开始使用'}
              <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </Link>
          </div>
        </article>
      </div>
    </div>
  )
}
