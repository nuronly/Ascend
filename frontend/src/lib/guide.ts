import { api } from '@/lib/api'
import { queryClient } from '@/lib/queryClient'

/**
 * 新手引导（比赛演示用，计划之后下线）。
 *
 * 进度判定分两类（见后端 app/api/guide.py）：
 *   建卡类 —— 后端按数据判定（只认引导开始之后的动作）
 *   浏览类 —— 前端到这里打点（read_section / view_graph / ask_brain）
 */

export type GuideStepKey =
  | 'read_section'
  | 'create_card'
  | 'nest_card'
  | 'vault_card'
  | 'view_graph'
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
