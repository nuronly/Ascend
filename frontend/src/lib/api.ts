/**
 * API 客户端。
 *
 * 鉴权全靠 httpOnly cookie，前端拿不到也不需要拿 token
 * —— 本产品渲染大量 LLM 生成的 Markdown，XSS 面比普通应用大，
 * token 放 localStorage 等于把钥匙插在门上（PLAN §4.2）。
 */

const BASE = '/api'

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message)
  }
}

/** access token 15 分钟就过期，401 时静默刷新一次再重放请求。 */
let refreshing: Promise<boolean> | null = null

async function tryRefresh(): Promise<boolean> {
  if (!refreshing) {
    refreshing = fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      credentials: 'same-origin',
    })
      .then((r) => r.ok)
      .catch(() => false)
      .finally(() => {
        setTimeout(() => (refreshing = null), 0)
      })
  }
  return refreshing
}

async function parseError(res: Response): Promise<ApiError> {
  let detail = res.statusText
  let code: string | undefined
  try {
    const body = await res.json()
    if (typeof body.detail === 'string') detail = body.detail
    else if (Array.isArray(body.detail)) detail = body.detail.map((d: any) => d.msg).join('；')
    code = body.code
  } catch {
    /* 响应不是 JSON，用状态文本兜底 */
  }
  return new ApiError(res.status, detail, code)
}

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'same-origin',
    headers:
      init.body && !(init.body instanceof FormData)
        ? { 'Content-Type': 'application/json', ...init.headers }
        : init.headers,
    ...init,
  })

  if (res.status === 401 && retry && !path.startsWith('/auth/')) {
    if (await tryRefresh()) return request<T>(path, init, false)
  }
  if (!res.ok) throw await parseError(res)
  if (res.status === 204) return undefined as T
  return res.json()
}

export const api = {
  get: <T>(p: string) => request<T>(p),
  post: <T>(p: string, body?: unknown) =>
    request<T>(p, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(p: string, body?: unknown) =>
    request<T>(p, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) }),
  del: <T>(p: string) => request<T>(p, { method: 'DELETE' }),
}

/* ════════════════════════════════════════════════════════════
   SSE
   用 fetch + ReadableStream 而不是 EventSource，因为：
     1. EventSource 只支持 GET，我们有大量 POST 流式端点
     2. EventSource 无法自定义 header / 传 body
     3. 需要 AbortController 在用户离开页面时立刻掐断生成，
        否则 token 会烧在没人看的响应上
   ════════════════════════════════════════════════════════════ */

export interface SSEHandlers {
  onEvent?: (event: string, data: any) => void
  onDelta?: (text: string) => void
  onError?: (message: string) => void
  onDone?: (data: any) => void
  signal?: AbortSignal
}

export async function sse(
  path: string,
  opts: { method?: 'GET' | 'POST'; body?: unknown } & SSEHandlers,
): Promise<void> {
  const { method = 'GET', body, onEvent, onDelta, onError, onDone, signal } = opts

  const run = async (isRetry: boolean): Promise<Response> =>
    fetch(`${BASE}${path}`, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    }).then(async (res) => {
      if (res.status === 401 && !isRetry && (await tryRefresh())) return run(true)
      return res
    })

  const res = await run(false)

  if (!res.ok) {
    const err = await parseError(res)
    onError?.(err.message)
    throw err
  }
  if (!res.body) {
    onError?.('浏览器不支持流式响应')
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE 帧以空行分隔；网络分片可能把一帧切开，所以留住最后一段不完整的
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''

      for (const frame of frames) {
        let event = 'message'
        const dataLines: string[] = []
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
          // 以 ':' 开头的是心跳注释帧，忽略
        }
        if (!dataLines.length) continue
        let data: any
        try {
          data = JSON.parse(dataLines.join('\n'))
        } catch {
          continue
        }

        onEvent?.(event, data)
        if (event === 'delta' && typeof data?.text === 'string') onDelta?.(data.text)
        else if (event === 'error') onError?.(data?.message ?? '生成失败')
        else if (event === 'done') onDone?.(data)
      }
    }
  } catch (e: any) {
    // 用户主动取消不算错误
    if (e?.name !== 'AbortError') onError?.(e?.message ?? '连接中断')
  } finally {
    reader.releaseLock()
  }
}
