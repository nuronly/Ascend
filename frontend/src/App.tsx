import { useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from './lib/queryClient'
import { Layout } from './components/Layout'
import { Toaster } from './components/Toaster'
import DesktopPet from './components/DesktopPet'
import { ErrorBoundary } from './components/ErrorBoundary'
import { useAuth, usePomodoro } from './lib/store'
import { Spinner } from './components/ui'

import LoginPage from './pages/Login'
import GuidePage from './pages/Guide'
import HomePage from './pages/Home'
import CalibratePage from './pages/Calibrate'
import CoursePage from './pages/Course'
import SectionPage from './pages/Section'
import DocumentsPage from './pages/Documents'
import DocReaderPage from './pages/DocReader'
import VaultPage from './pages/Vault'
import BrainPage from './pages/Brain'
import ReviewPage from './pages/Review'
import BadgesPage from './pages/Badges'
import SettingsPage from './pages/Settings'
import FeedbackPage from './pages/Feedback'

function Guard({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Spinner className="size-5 text-[var(--text-subtle)]" />
      </div>
    )
  }
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />
  return <>{children}</>
}

/**
 * 番茄钟心跳。
 *
 * 只做「算差值」，绝不累加 —— 后台标签页里 setInterval 会被节流到
 * 1 次/分钟，累加式计时必然走不准（PLAN §7 风险 #6）。
 * 被节流也无所谓：回到前台时 visibilitychange 立刻补算一次。
 */
function PomodoroHeartbeat() {
  const tick = usePomodoro((s) => s.tick)
  const load = usePomodoro((s) => s.load)
  const user = useAuth((s) => s.user)

  useEffect(() => {
    if (!user) return
    load()
    const id = setInterval(tick, 1000)
    const onVisible = () => {
      if (!document.hidden) {
        tick()
        load() // 顺便跟服务端对齐，跨设备也一致
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [user, tick, load])

  return null
}

function Boot({ children }: { children: React.ReactNode }) {
  const load = useAuth((s) => s.load)
  useEffect(() => {
    load()
  }, [load])
  return <>{children}</>
}

/** 路由级错误边界：一个页面崩了不会拖垮导航，切换路由自动恢复。 */
function Page({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  return (
    <ErrorBoundary variant="page" resetKey={location.pathname}>
      {children}
    </ErrorBoundary>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Boot>
          <PomodoroHeartbeat />
          <Toaster />
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            {/* 使用说明放在 Guard 之外：没登录也该能看懂这产品是干嘛的 */}
            <Route path="/guide" element={<GuidePage />} />
            <Route
              path="/*"
              element={
                <Guard>
                  <Layout>
                    <Page>
                      <Routes>
                        <Route path="/" element={<HomePage />} />
                        {/* 开课前的边界校准（取代难度等级）。单独一条路由，
                            这样浏览器返回键能回到主题输入，不会丢上下文 */}
                        <Route path="/new" element={<CalibratePage />} />
                        <Route path="/courses/:courseId" element={<CoursePage />} />
                        <Route
                          path="/courses/:courseId/sections/:sectionId"
                          element={<SectionPage />}
                        />
                        <Route path="/documents" element={<DocumentsPage />} />
                        <Route path="/documents/:docId" element={<DocReaderPage />} />
                        {/* 笔记是主界面；/vault 保留，老链接与书签不该失效 */}
                        <Route path="/notes" element={<VaultPage />} />
                        <Route path="/vault" element={<VaultPage />} />
                        <Route path="/badges" element={<BadgesPage />} />
                        {/* 全局图谱已整块撤除：卡片不再是一张需要俯瞰的网，
                            它绑定在小节与笔记上。小节内的连线仍在卡片空间里 */}
                        <Route path="/brain" element={<BrainPage />} />
                        <Route path="/review" element={<ReviewPage />} />
                        <Route path="/settings" element={<SettingsPage />} />
                        <Route path="/feedback" element={<FeedbackPage />} />
                        <Route path="*" element={<Navigate to="/" replace />} />
                      </Routes>
                    </Page>
                    {/* 桌宠挂在 Guard 里面、Page 外面：
                        · 在 Guard 里 —— 它说的话全是「你的」学习状态，没登录时无从谈起
                        · 在 Page 外面 —— 某个页面崩了它还在，而它恰好是那时候
                          唯一还能用的入口（能问第二大脑、能跳走） */}
                    <DesktopPet />
                  </Layout>
                </Guard>
              }
            />
          </Routes>
        </Boot>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
