/**
 * 代码高亮。
 *
 * 直接 `import { codeToHtml } from 'shiki'` 会把两百多种语言全部打进
 * 产物（首屏 1.5MB+）。这里改用 core + 动态注册：
 * 只有真正出现过的语言才会被下载，而且各自单独成 chunk。
 */
import type { HighlighterCore } from 'shiki/core'

/** 别名 → Shiki 语言 id */
const ALIASES: Record<string, string> = {
  py: 'python',
  py3: 'python',
  js: 'javascript',
  mjs: 'javascript',
  ts: 'typescript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  yml: 'yaml',
  'c++': 'cpp',
  cxx: 'cpp',
  'objective-c': 'c',
  golang: 'go',
  rs: 'rust',
  kt: 'kotlin',
  md: 'markdown',
  tex: 'latex',
  text: 'plaintext',
  txt: 'plaintext',
  '': 'plaintext',
}

/** 学习场景里真正用得上的语言。列表之外的一律降级为纯文本，不额外下载。 */
const LOADERS: Record<string, () => Promise<any>> = {
  python: () => import('shiki/langs/python.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  r: () => import('shiki/langs/r.mjs'),
  latex: () => import('shiki/langs/latex.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  plaintext: async () => null,
}

export function resolveLang(lang: string): string | null {
  const key = (ALIASES[lang.toLowerCase()] ?? lang.toLowerCase()).trim()
  return key in LOADERS ? key : null
}

let corePromise: Promise<HighlighterCore> | null = null
const loaded = new Set<string>(['plaintext'])

async function getCore(): Promise<HighlighterCore> {
  if (!corePromise) {
    corePromise = (async () => {
      const [{ createHighlighterCore }, { createOnigurumaEngine }] = await Promise.all([
        import('shiki/core'),
        import('shiki/engine/oniguruma'),
      ])
      return createHighlighterCore({
        themes: [
          import('shiki/themes/vitesse-light.mjs'),
          import('shiki/themes/vitesse-dark.mjs'),
        ],
        langs: [],
        engine: createOnigurumaEngine(import('shiki/wasm')),
      })
    })()
  }
  return corePromise
}

export async function highlight(code: string, lang: string, dark: boolean): Promise<string | null> {
  const resolved = resolveLang(lang)
  if (!resolved || resolved === 'plaintext') return null

  const core = await getCore()
  if (!loaded.has(resolved)) {
    const mod = await LOADERS[resolved]()
    if (mod) {
      await core.loadLanguage(mod.default ?? mod)
      loaded.add(resolved)
    }
  }
  return core.codeToHtml(code, {
    lang: resolved,
    theme: dark ? 'vitesse-dark' : 'vitesse-light',
  })
}
