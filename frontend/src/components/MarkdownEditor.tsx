import { markdown } from '@codemirror/lang-markdown'
import { Prec } from '@codemirror/state'
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { fileUrl } from '../lib/api'
import { Markdown } from './Markdown'
import { toast, toastError } from './toast'
import { Button } from './ui'

export type Uploader = (file: File, inline: boolean, onProgress: (pct: number) => void) => Promise<{ id: string; filename: string }>

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']

function useDark() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  useEffect(() => {
    const o = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')))
    o.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => o.disconnect()
  }, [])
  return dark
}

/**
 * Markdown is the source of truth. Pasting/dropping an image uploads it and inserts `![](/api/files/<id>)`;
 * other dropped files become regular attachments with a download link.
 */
export function MarkdownEditor({
  value,
  onSave,
  onCancel,
  upload,
  placeholder,
  saveLabel,
  minHeight = 160,
  autoFocus = true,
  clearOnSave,
}: {
  value: string
  onSave: (v: string) => Promise<unknown> | void
  onCancel?: () => void
  upload?: Uploader
  placeholder?: string
  saveLabel?: string
  minHeight?: number
  autoFocus?: boolean
  clearOnSave?: boolean
}) {
  const { t } = useTranslation()
  const [text, setText] = useState(value)
  const [tab, setTab] = useState<'write' | 'preview'>('write')
  const [saving, setSaving] = useState(false)
  const [resetKey, setResetKey] = useState(0) // remounts CodeMirror after clearing (it doesn't always take a new `value`)
  const ref = useRef<ReactCodeMirrorRef>(null)
  const dark = useDark()
  const textRef = useRef(text)
  textRef.current = text

  const save = async () => {
    setSaving(true)
    try {
      await onSave(textRef.current)
      if (clearOnSave) {
        setText('')
        setResetKey((k) => k + 1)
        setTab('write')
      }
    } finally {
      setSaving(false)
    }
  }
  const saveRef = useRef(save)
  saveRef.current = save
  const cancelRef = useRef(onCancel)
  cancelRef.current = onCancel
  const uploadRef = useRef(upload)
  uploadRef.current = upload

  const extensions = useMemo(() => {
    const insertFiles = (view: EditorView, files: File[], at?: number) => {
      const up = uploadRef.current
      if (!up || files.length === 0) return false
      for (const file of files) {
        const isImage = IMAGE_TYPES.includes(file.type)
        const name = file.name && file.name !== 'image.png' ? file.name : `pasted-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`
        const marker = `![${t('card.uploading', { name, pct: 0 })}]()`
        const pos = at ?? view.state.selection.main.head
        view.dispatch({ changes: { from: pos, insert: marker + '\n' } })
        const replace = (insert: string) => {
          const doc = view.state.doc.toString()
          const i = doc.indexOf(marker)
          if (i >= 0) view.dispatch({ changes: { from: i, to: i + marker.length, insert } })
        }
        up(new File([file], name, { type: file.type }), isImage, () => {})
          .then((a) => {
            const safe = a.filename.replace(/[[\]]/g, '')
            replace(isImage ? `![${safe}](${fileUrl(a.id)})` : `[📎 ${safe}](${fileUrl(a.id)}?download=1)`)
          })
          .catch((e) => {
            replace('')
            toastError(e)
          })
      }
      return true
    }
    return [
      markdown(),
      EditorView.lineWrapping,
      cmPlaceholder(placeholder ?? ''),
      // highest precedence: the default keymap binds Mod-Enter to insertBlankLine
      Prec.highest(keymap.of([
        { key: 'Mod-Enter', run: () => (saveRef.current(), true) },
        { key: 'Mod-s', run: () => (saveRef.current(), true), preventDefault: true },
        { key: 'Escape', run: () => (cancelRef.current?.(), !!cancelRef.current) },
      ])),
      EditorView.domEventHandlers({
        paste(e, view) {
          const files = [...(e.clipboardData?.files ?? [])]
          if (files.length === 0) return false
          e.preventDefault()
          if (!uploadRef.current) {
            toast(t('errors.forbidden'), 'error')
            return true
          }
          return insertFiles(view, files)
        },
        drop(e, view) {
          const files = [...(e.dataTransfer?.files ?? [])]
          if (files.length === 0) return false
          e.preventDefault()
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? undefined
          return insertFiles(view, files, pos)
        },
      }),
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeholder])

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1 text-xs">
        {(['write', 'preview'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={clsx(
              'rounded-md px-2.5 py-1 font-medium cursor-pointer',
              tab === k ? 'bg-black/5 dark:bg-white/10' : 'text-muted hover:bg-black/5 dark:hover:bg-white/5',
            )}
          >
            {t(`card.${k}`)}
          </button>
        ))}
        <span className="ml-auto text-muted">{t('card.markdownHint')}</span>
      </div>
      {tab === 'write' ? (
        <div className="overflow-hidden rounded-lg border border-line">
          <CodeMirror
            key={resetKey}
            ref={ref}
            value={text}
            onChange={setText}
            extensions={extensions}
            theme={dark ? 'dark' : 'light'}
            autoFocus={autoFocus}
            minHeight={`${minHeight}px`}
            maxHeight="60vh"
            basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false, highlightActiveLineGutter: false }}
          />
        </div>
      ) : (
        <div className="min-h-24 rounded-lg border border-line p-3" style={{ minHeight }}>
          <Markdown source={text || '—'} />
        </div>
      )}
      <div className="flex gap-2">
        <Button variant="primary" size="sm" onClick={save} disabled={saving || (clearOnSave && !text.trim())}>
          {saveLabel ?? t('common.save')}
        </Button>
        {onCancel && (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        )}
        <span className="ml-auto self-center text-xs text-muted">Ctrl+Enter</span>
      </div>
    </div>
  )
}
