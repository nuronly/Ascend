import { useEffect, useState } from 'react'

/**
 * 当前是否深色主题。
 *
 * Canvas 渲染（图谱、记忆网络）读不到 CSS 变量，只能在 JS 里挑调色板，
 * 所以需要主动订阅 html 上 dark 类的变化。
 */
export function useIsDark() {
  const [dark, setDark] = useState(
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
  )
  useEffect(() => {
    const ob = new MutationObserver(() =>
      setDark(document.documentElement.classList.contains('dark')),
    )
    ob.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => ob.disconnect()
  }, [])
  return dark
}
