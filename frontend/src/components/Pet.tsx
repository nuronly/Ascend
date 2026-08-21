import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * 桌宠的形象。
 *
 * ★ 为什么手画 SVG 而不是找一张图 / 上 Lottie
 *   · 一张 png 在深浅两套主题下必然有一套是错的；SVG 吃 CSS 变量，天然跟随
 *   · 表情要跟状态联动（在想 / 在说 / 闲着），图片做不到，Lottie 又是一整个
 *     新依赖 + 一份美术资产
 *   · 手画的这只就三十行，改起来不用求人
 *
 * ★ 瞳孔跟随鼠标是「陪伴感」性价比最高的一笔
 *   十几行代码，但它让这东西从「一个贴图」变成「一个在看着你的东西」。
 *   比任何复杂动画都划算。
 */

export type PetMood = 'idle' | 'talk' | 'think' | 'happy'

interface Props {
  mood?: PetMood
  size?: number
  className?: string
  /** 有话没说时耳朵上挂个小红点 */
  alert?: boolean
}

export function Pet({ mood = 'idle', size = 56, className, alert }: Props) {
  const ref = useRef<SVGSVGElement>(null)
  // 瞳孔偏移，单位是 SVG 坐标
  const [eye, setEye] = useState({ x: 0, y: 0 })
  const [blink, setBlink] = useState(false)

  /* 眼睛跟着鼠标转。限幅在 ±2.2，再多就变成斗鸡眼了 */
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const el = ref.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const dx = e.clientX - (r.left + r.width / 2)
      const dy = e.clientY - (r.top + r.height / 2)
      const d = Math.hypot(dx, dy) || 1
      const k = Math.min(d / 220, 1) * 2.2
      setEye({ x: (dx / d) * k, y: (dy / d) * k })
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [])

  /* 眨眼。间隔随机 —— 等间隔的眨眼看着像机器 */
  useEffect(() => {
    let t: number
    const loop = () => {
      t = window.setTimeout(() => {
        setBlink(true)
        window.setTimeout(() => setBlink(false), 130)
        loop()
      }, 2200 + Math.random() * 3800)
    }
    loop()
    return () => window.clearTimeout(t)
  }, [])

  const talking = mood === 'talk'
  const thinking = mood === 'think'

  return (
    <svg
      ref={ref}
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={cn('overflow-visible', mood === 'idle' && 'pet-breathe', className)}
      aria-hidden
    >
      {/* 影子：让它看起来是"站"在界面上的，而不是浮在半空 */}
      <ellipse cx="32" cy="59" rx="14" ry="2.6" className="fill-[var(--text)]" opacity="0.09" />

      {/* 天线 —— 思考时会晃，是最省事的"正在想"信号 */}
      <g className={thinking ? 'pet-antenna' : undefined} style={{ transformOrigin: '32px 18px' }}>
        <path
          d="M32 18 Q33.5 11 38 8.5"
          className="stroke-[var(--text-subtle)]"
          strokeWidth="1.6"
          strokeLinecap="round"
          fill="none"
        />
        <circle cx="38.6" cy="8" r="2.4" className="fill-[var(--accent)]" />
      </g>

      {/* 身体 */}
      <path
        d="M32 17c9.4 0 16.5 6.6 16.5 16.5v6C48.5 49 41.4 55 32 55s-16.5-6-16.5-15.5v-6C15.5 23.6 22.6 17 32 17z"
        className="fill-[var(--bg-raised)] stroke-[var(--border-strong)]"
        strokeWidth="1.7"
      />

      {/* 眼睛 */}
      <g transform={`translate(${eye.x} ${eye.y})`}>
        {[24.5, 39.5].map((cx) => (
          <g key={cx}>
            <ellipse
              cx={cx}
              cy="33"
              rx="4.4"
              ry={blink ? 0.5 : 4.9}
              className="fill-[var(--text)]"
              style={{ transition: 'ry 90ms ease' }}
            />
            {!blink && (
              // 高光：一点白就让眼睛"活"了
              <circle cx={cx + 1.5} cy="31" r="1.35" fill="#fff" opacity="0.9" />
            )}
          </g>
        ))}
      </g>

      {/* 嘴：说话时张合，开心时上扬 */}
      {talking ? (
        <ellipse cx="32" cy="43" rx="3.4" ry="2.6" className="fill-[var(--text)] pet-mouth" />
      ) : mood === 'happy' ? (
        <path
          d="M28 42q4 4 8 0"
          className="stroke-[var(--text)]"
          strokeWidth="1.7"
          strokeLinecap="round"
          fill="none"
        />
      ) : (
        <path
          d="M29.5 43h5"
          className="stroke-[var(--text-subtle)]"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      )}

      {/* 腮红：只在开心时出现 */}
      {mood === 'happy' && (
        <>
          <ellipse cx="19.5" cy="39.5" rx="3" ry="1.8" className="fill-[var(--sem-due)]" opacity="0.42" />
          <ellipse cx="44.5" cy="39.5" rx="3" ry="1.8" className="fill-[var(--sem-due)]" opacity="0.42" />
        </>
      )}

      {alert && (
        <circle cx="47" cy="20" r="4" className="fill-[var(--sem-danger)] stroke-[var(--bg)]" strokeWidth="1.6" />
      )}
    </svg>
  )
}
