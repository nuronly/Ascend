import { QueryClient } from '@tanstack/react-query'

/**
 * 全局 QueryClient。单例提出来是为了让非组件代码（如引导打点）
 * 也能 invalidateQueries，保持面板数据新鲜。
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})
