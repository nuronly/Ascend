/**
 * Document Picture-in-Picture：把一块 DOM 放进一个**始终置顶的原生小窗**。
 *
 * ★ 为什么用它做桌宠
 *   这是个跑在浏览器里的 Web 应用，DOM 活在标签页里 —— 想让宠物在你切到
 *   编辑器之后还看得见，只有三条路：Electron/Tauri（要用户下载安装）、
 *   浏览器扩展（还是在浏览器里）、或者这个 API。
 *   它给的是真正的操作系统级窗口：置顶、无浏览器 UI、可拖可缩放，
 *   而代价是零 —— 不装东西、不加构建链。
 *
 * ⚠️ 两个坑，不知道的话会卡很久
 *   1. PiP 窗口是**独立的 document**，主页面的 <style> / <link> 一个都不会过去。
 *      不手动克隆的话，里面是一坨没有样式的裸 HTML。
 *   2. 暗色主题挂在 <html class="dark"> 上，也得同步 —— 否则白底黑字混着 CSS
 *      变量的深色值，看起来像坏了。
 *
 * 兼容性：Chromium 系（Chrome 116+ / Edge）。Safari 与 Firefox 没有，
 * 所以调用方必须有降级路径（页面内浮窗）。
 */

interface DocumentPiP {
  requestWindow(opts?: { width?: number; height?: number }): Promise<Window>
  window: Window | null
}

function api(): DocumentPiP | null {
  const it = (window as unknown as { documentPictureInPicture?: DocumentPiP })
    .documentPictureInPicture
  return it && typeof it.requestWindow === 'function' ? it : null
}

export function pipSupported(): boolean {
  return api() !== null
}

/**
 * 把主页面的样式复制进 PiP 窗口。
 *
 * 两种来源都要管：同源的 <style>/<link> 能读到 cssRules，直接内联进去最稳；
 * 跨域样式表读 cssRules 会抛 SecurityError，那就退回挂一个同 href 的 <link>。
 */
function cloneStyles(target: Window): void {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const css = Array.from(sheet.cssRules)
        .map((r) => r.cssText)
        .join('\n')
      const style = target.document.createElement('style')
      style.textContent = css
      target.document.head.appendChild(style)
    } catch {
      const href = (sheet as CSSStyleSheet).href
      if (!href) continue
      const link = target.document.createElement('link')
      link.rel = 'stylesheet'
      link.href = href
      target.document.head.appendChild(link)
    }
  }
}

/** 同步 <html> 上的类（暗色主题就挂在这儿）。 */
function syncTheme(target: Window): () => void {
  const apply = () => {
    target.document.documentElement.className = document.documentElement.className
  }
  apply()
  const ob = new MutationObserver(apply)
  ob.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => ob.disconnect()
}

export interface PipHandle {
  win: Window
  /** 主动关掉（用户点「收回页面」时）。窗口被用户直接关闭时不用调 */
  close: () => void
}

/**
 * 开一个 PiP 窗口。
 *
 * ⚠️ 必须在**用户手势**（click）的调用栈里调用，否则浏览器直接拒绝 ——
 *    放在 useEffect 里自动弹是不行的。
 *
 * onClose 在窗口关闭时触发（用户点关闭按钮、或者主页面被关掉）。
 */
export async function openPip(
  opts: { width?: number; height?: number },
  onClose: () => void,
): Promise<PipHandle | null> {
  const it = api()
  if (!it) return null
  const win = await it.requestWindow({ width: opts.width ?? 300, height: opts.height ?? 400 })

  cloneStyles(win)
  const stopTheme = syncTheme(win)
  // 小窗里不需要滚动条与页边距
  win.document.body.style.margin = '0'
  win.document.body.style.overflow = 'hidden'
  win.document.body.style.background = 'transparent'

  const cleanup = () => {
    stopTheme()
    onClose()
  }
  win.addEventListener('pagehide', cleanup, { once: true })

  return {
    win,
    close: () => {
      win.removeEventListener('pagehide', cleanup)
      stopTheme()
      win.close()
    },
  }
}
