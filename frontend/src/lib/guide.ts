import { api } from '@/lib/api'
import { queryClient } from '@/lib/queryClient'

/**
 * 新手引导（比赛演示用，计划之后下线）。
 *
 * 进度判定分两类（见后端 app/api/guide.py）：
 *   建卡类 —— 后端按数据判定（只认引导开始之后的动作）
 *   浏览类 —— 前端到这里打点（read_section / ask_brain）
 *
 * 主路径跟着产品改过：「把卡收进仓库」没了（卡片不再有状态分类），
 * 「打开图谱」也没了（全局图谱整块撤除），终点动作换成「把这一节收成笔记」。
 */

export type GuideStepKey =
  | 'read_section'
  | 'create_card'
  | 'nest_card'
  | 'make_note'
  | 'ask_brain'

export interface GuideProgress {
  started: boolean
  dismissed: boolean
  steps: { key: GuideStepKey; done: boolean }[]
  first_section: { section_id: string; course_id: string } | null
}

/** 打点。静默失败 —— 引导是辅助功能，绝不能影响主流程 */
export function reportGuideStep(step: GuideStepKey) {
  api
    .post('/guide/event', { step })
    .then(() => queryClient.invalidateQueries({ queryKey: ['guide-progress'] }))
    .catch(() => {})
}
