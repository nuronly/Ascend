import type { Resource } from '@/lib/types'

/**
 * 工具调用在界面上的呈现。
 *
 * ★ 为什么要收成一处
 *
 *   工具调用现在出现在四个地方：大纲、正文、笔记、第二大脑。原来每处各写一份
 *   映射，加一件工具就要改四处 —— 而漏掉的那处不会报错，只会显示成函数名
 *   （`read_note`）。第二大脑那一版还把「读我那一节的笔记全文」标成了
 *   「联网检索」，因为标签是写死在 RunTimeline 里的。
 *
 * ★ 为什么要说人话
 *
 *   「它查了什么」是可解释性的核心。用户要能一眼看出这次讲解是**基于他自己
 *   的记录**，而不是又一份通用教程 —— 显示成 `search_memory` 就白费了。
 */

export interface ToolStep {
  name: string
  /** 动作本身（「读我的笔记全文」）。不给就退回工具名 */
  label?: string
  /** 这次动作的对象：检索词之类。没有就不显示 */
  query: string
  state: 'running' | 'done' | 'error'
  /** 结果的一句话（后端 ToolResult.summary） */
  detail?: string
  items?: Resource[]
}

/** 工具 → 人话动作名。 */
export const TOOL_ACTION: Record<string, string> = {
  web_search: '联网核实',
  search_memory: '翻我的学习记录',
  // 它既能读某一节的笔记，也能读某一张疑问卡 —— 说「笔记全文」会让人
  // 看到「读我那一节的笔记全文」却实际读的是一张卡，对不上
  read_note: '读我记下来的全文',
  read_outline: '查这门课的大纲与前置依赖',
  my_boundary: '看我的已知边界',
}

/**
 * 哪些工具的参数不值得摆给用户看。
 *
 * read_note 的参数是一串 id、my_boundary 根本没有参数 —— 后端 _call_detail
 * 在没有 query 时会退回工具名，直接显示就成了「读我那一节的笔记全文 · read_note」。
 */
const QUERYLESS = new Set(['read_note', 'read_outline', 'my_boundary'])

/** 一次工具调用开始 → 时间线上的一步。 */
export function toolStep(name: string, detail?: string): ToolStep {
  const raw = (detail ?? '').trim()
  return {
    name,
    label: TOOL_ACTION[name] ?? name,
    // detail 恰好等于工具名，说明后端没拿到查询词，别把它当查询词显示
    query: QUERYLESS.has(name) || raw === name ? '' : raw,
    state: 'running',
  }
}

/**
 * 工具返回 → 回填到最后一条 running 上。
 *
 * 工具是串行执行的（router 的 tool loop 逐个 await），所以「最后一条」
 * 一定就是刚刚返回的那条，不会错位。
 */
export function settleStep(
  steps: ToolStep[],
  ok: boolean,
  data?: { detail?: string; items?: Resource[] },
): ToolStep[] {
  if (!steps.length) return steps
  return steps.map((s, i) =>
    i === steps.length - 1
      ? { ...s, state: ok ? 'done' : 'error', detail: data?.detail, items: data?.items ?? [] }
      : s,
  )
}
