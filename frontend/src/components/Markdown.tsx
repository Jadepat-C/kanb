import clsx from 'clsx'
import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'

// Sanitized (no raw HTML, no scripts, no data: URLs). Relative /api/files/... images are allowed.
const schema = { ...defaultSchema }

type HastNode = { type: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] }

/** Numbers task-list checkboxes so a click can toggle the matching `- [ ]` in the source. */
function rehypeTaskIndex() {
  return (tree: HastNode) => {
    let i = 0
    const walk = (n: HastNode) => {
      if (n.type === 'element' && n.tagName === 'input' && n.properties?.type === 'checkbox') {
        n.properties.dataTaskIndex = i++
      }
      n.children?.forEach(walk)
    }
    walk(tree)
  }
}

const TASK_RE = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/gm

export function toggleTask(md: string, index: number): string {
  let i = -1
  return md.replace(TASK_RE, (m, a: string, c: string, b: string) => {
    i++
    return i === index ? a + (c === ' ' ? 'x' : ' ') + b : m
  })
}

export const Markdown = memo(function Markdown({
  source,
  onToggleTask,
  compact,
  className,
  fileBase,
}: {
  source: string
  onToggleTask?: (index: number) => void
  compact?: boolean
  className?: string
  /** serve this card's pictures and files from here instead of /api/files (a public board link) */
  fileBase?: string
}) {
  const file = (url: unknown) => (fileBase && typeof url === 'string' && url.startsWith('/api/files/') ? fileBase + url.slice('/api/files'.length) : (url as string | undefined))
  return (
    <div className={clsx('md prose prose-sm max-w-none dark:prose-invert', compact && 'md-compact', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, schema], rehypeTaskIndex]}
        components={{
          a: ({ node: _n, ...p }) => <a {...p} href={file(p.href)} target="_blank" rel="noopener noreferrer" />,
          img: ({ node: _n, ...p }) => <img {...p} src={file(p.src)} loading="lazy" />,
          input: ({ node, ...p }) => {
            if (p.type !== 'checkbox') return <input {...p} />
            const idx = Number((node?.properties as Record<string, unknown>)?.dataTaskIndex ?? -1)
            return (
              <input
                type="checkbox"
                checked={!!p.checked}
                disabled={!onToggleTask}
                onClick={(e) => e.stopPropagation()}
                onChange={() => onToggleTask?.(idx)}
                className={onToggleTask ? 'cursor-pointer' : undefined}
              />
            )
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  )
})
