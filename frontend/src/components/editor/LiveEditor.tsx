import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { Compartment, EditorSelection, EditorState, Prec } from '@codemirror/state'
import { drawSelection, EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view'
import clsx from 'clsx'
import {
  Bold,
  Code,
  Heading,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Quote,
  SquareCode,
  Strikethrough,
  Table,
} from 'lucide-react'
import { forwardRef, useEffect, useImperativeHandle, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { fileUrl } from '../../lib/api'
import { toast, toastError } from '../toast'
import { livePreview, liveTables, readOnlyLinks } from './livePreview'

export type Uploader = (file: File, inline: boolean, onProgress: (pct: number) => void) => Promise<{ id: string; filename: string }>

export interface LiveEditorHandle {
  focus: () => void
  getValue: () => string
  setValue: (v: string) => void
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']

// ---------- formatting commands (used by toolbar + shortcuts) ----------

function wrap(view: EditorView, marker: string) {
  view.dispatch(
    view.state.changeByRange((r) => {
      const text = view.state.sliceDoc(r.from, r.to)
      const before = view.state.sliceDoc(r.from - marker.length, r.from)
      const after = view.state.sliceDoc(r.to, r.to + marker.length)
      if (before === marker && after === marker) {
        // already wrapped -> unwrap
        return {
          changes: [
            { from: r.from - marker.length, to: r.from, insert: '' },
            { from: r.to, to: r.to + marker.length, insert: '' },
          ],
          range: EditorSelection.range(r.from - marker.length, r.to - marker.length),
        }
      }
      return {
        changes: { from: r.from, to: r.to, insert: marker + text + marker },
        range: EditorSelection.range(r.from + marker.length, r.to + marker.length),
      }
    }),
  )
  view.focus()
  return true
}

/** Toggle a line prefix ("- ", "> ", "1. " …) on every selected line. Headings cycle # → ## → ### → none. */
function prefix(view: EditorView, p: string | 'heading') {
  const { state } = view
  const changes: { from: number; to?: number; insert: string }[] = []
  const seen = new Set<number>()
  for (const r of state.selection.ranges) {
    for (let pos = r.from; pos <= r.to; ) {
      const line = state.doc.lineAt(pos)
      pos = line.to + 1
      if (seen.has(line.from)) continue
      seen.add(line.from)
      if (p === 'heading') {
        const m = /^(#{1,6}) /.exec(line.text)
        const level = m ? m[1].length : 0
        const next = level >= 3 ? '' : '#'.repeat(level + 1) + ' '
        changes.push({ from: line.from, to: line.from + (m ? m[0].length : 0), insert: next })
        continue
      }
      const existing = /^(\s*)([-*+] \[[ xX]\] |[-*+] |\d+[.)] |> )/.exec(line.text)
      if (existing && existing[2] === p) changes.push({ from: line.from + existing[1].length, to: line.from + existing[0].length, insert: '' })
      else if (existing) changes.push({ from: line.from + existing[1].length, to: line.from + existing[0].length, insert: p })
      else changes.push({ from: line.from, insert: p })
    }
  }
  view.dispatch({ changes })
  view.focus()
  return true
}

function insertBlock(view: EditorView, text: string, cursorOffset: number) {
  const r = view.state.selection.main
  const line = view.state.doc.lineAt(r.from)
  const lead = line.text.trim() ? '\n' : ''
  const sel = view.state.sliceDoc(r.from, r.to)
  const body = text.replace('$SEL', sel)
  view.dispatch({
    changes: { from: r.from, to: r.to, insert: lead + body },
    selection: { anchor: r.from + lead.length + cursorOffset + sel.length },
  })
  view.focus()
  return true
}

/** Inserts a 2×1 table on its own lines and selects the first header so typing replaces it. */
function insertTable(view: EditorView, h1: string, h2: string) {
  const r = view.state.selection.main
  const line = view.state.doc.lineAt(r.head)
  const at = line.text.trim() ? line.to : line.from
  const lead = line.text.trim() ? '\n\n' : at > 0 && view.state.doc.lineAt(at - 1).text.trim() ? '\n' : ''
  const table = `| ${h1} | ${h2} |\n| --- | --- |\n|  |  |\n`
  const start = at + lead.length + 2
  view.dispatch({ changes: { from: at, insert: lead + table }, selection: { anchor: start, head: start + h1.length } })
  view.focus()
  return true
}

function insertLink(view: EditorView) {
  const r = view.state.selection.main
  const text = view.state.sliceDoc(r.from, r.to)
  const isUrl = /^https?:\/\//.test(text)
  const insert = isUrl ? `[](${text})` : `[${text}](https://)`
  view.dispatch({
    changes: { from: r.from, to: r.to, insert },
    selection: isUrl ? { anchor: r.from + 1 } : { anchor: r.from + text.length + 3, head: r.from + insert.length - 1 },
  })
  view.focus()
  return true
}

// ---------- component ----------

export const LiveEditor = forwardRef<
  LiveEditorHandle,
  {
    value: string
    onChange?: (v: string) => void
    onSubmit?: () => void
    onEscape?: () => boolean
    onBlur?: () => void
    upload?: Uploader
    readOnly?: boolean
    placeholder?: string
    autoFocus?: boolean
    minHeight?: number
    toolbar?: boolean
    toolbarExtra?: ReactNode
    className?: string
  }
>(function LiveEditor(props, ref) {
  const { t } = useTranslation()
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const propsRef = useRef(props)
  propsRef.current = props
  const roCompartment = useRef(new Compartment())

  useImperativeHandle(ref, () => ({
    focus: () => viewRef.current?.focus(),
    getValue: () => viewRef.current?.state.doc.toString() ?? '',
    setValue: (v: string) => {
      const view = viewRef.current
      if (view && view.state.doc.toString() !== v) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } })
    },
  }))

  // create once
  useEffect(() => {
    const insertFiles = (view: EditorView, files: File[], at?: number) => {
      const up = propsRef.current.upload
      if (!up) {
        toast(t('errors.forbidden'), 'error')
        return true
      }
      for (const file of files) {
        const isImage = IMAGE_TYPES.includes(file.type)
        const name =
          file.name && file.name !== 'image.png' ? file.name : `pasted-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`
        const marker = `![${t('card.uploading', { name, pct: 0 })}]()`
        // images are blocks: never split the current line (or its formatting), go below it instead
        const line = view.state.doc.lineAt(at ?? view.state.selection.main.head)
        const pos = line.text.trim() ? line.to : line.from
        const lead = line.text.trim() ? '\n' : ''
        view.dispatch({ changes: { from: pos, insert: lead + marker + '\n' }, selection: { anchor: pos + lead.length + marker.length + 1 } })
        const replace = (insert: string) => {
          const i = view.state.doc.toString().indexOf(marker)
          if (i >= 0) view.dispatch({ changes: { from: i, to: i + marker.length, insert } })
        }
        up(new File([file], name, { type: file.type }), isImage, () => {})
          .then((a) => {
            const safe = a.filename.replace(/[[\]()]/g, '')
            replace(isImage ? `![${safe}](${fileUrl(a.id)})` : `[📎 ${safe}](${fileUrl(a.id)}?download=1)`)
          })
          .catch((e) => {
            replace('')
            toastError(e)
          })
      }
      return true
    }

    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          history(),
          drawSelection(),
          EditorView.lineWrapping,
          markdown({ base: markdownLanguage }), // GFM; Enter continues lists, Backspace removes markers
          livePreview,
          liveTables,
          readOnlyLinks,
          cmPlaceholder(props.placeholder ?? ''),
          roCompartment.current.of([EditorState.readOnly.of(!!props.readOnly), EditorView.editable.of(!props.readOnly)]),
          Prec.highest(
            keymap.of([
              { key: 'Mod-Enter', run: () => (propsRef.current.onSubmit?.(), !!propsRef.current.onSubmit) },
              { key: 'Escape', run: () => propsRef.current.onEscape?.() ?? false },
              { key: 'Mod-b', run: (v) => wrap(v, '**') },
              { key: 'Mod-i', run: (v) => wrap(v, '*') },
              { key: 'Mod-e', run: (v) => wrap(v, '`') },
              { key: 'Mod-k', run: insertLink },
              { key: 'Mod-Shift-x', run: (v) => wrap(v, '~~') },
            ]),
          ),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) propsRef.current.onChange?.(u.state.doc.toString())
            if (u.focusChanged && !u.view.hasFocus) propsRef.current.onBlur?.()
          }),
          EditorView.domEventHandlers({
            paste(e, view) {
              const files = [...(e.clipboardData?.files ?? [])]
              if (files.length === 0 || view.state.readOnly) return false
              e.preventDefault()
              return insertFiles(view, files)
            },
            drop(e, view) {
              const files = [...(e.dataTransfer?.files ?? [])]
              if (files.length === 0 || view.state.readOnly) return false
              e.preventDefault()
              return insertFiles(view, files, view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? undefined)
            },
          }),
        ],
      }),
    })
    viewRef.current = view
    if (props.autoFocus) view.focus()
    return () => view.destroy()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // read-only can change (permissions update live)
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: roCompartment.current.reconfigure([EditorState.readOnly.of(!!props.readOnly), EditorView.editable.of(!props.readOnly)]),
    })
  }, [props.readOnly])

  // Adopt external changes (someone else edited) only while the user isn't typing here.
  useEffect(() => {
    const view = viewRef.current
    if (view && !view.hasFocus && view.state.doc.toString() !== props.value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: props.value } })
    }
  }, [props.value])

  const run = (f: (v: EditorView) => boolean) => () => viewRef.current && f(viewRef.current)
  const tools: { icon: ReactNode; title: string; run: () => void }[] = [
    { icon: <Heading size={15} />, title: `${t('editor.heading')}`, run: run((v) => prefix(v, 'heading')) },
    { icon: <Bold size={15} />, title: `${t('editor.bold')} (Ctrl+B)`, run: run((v) => wrap(v, '**')) },
    { icon: <Italic size={15} />, title: `${t('editor.italic')} (Ctrl+I)`, run: run((v) => wrap(v, '*')) },
    { icon: <Strikethrough size={15} />, title: `${t('editor.strike')} (Ctrl+Shift+X)`, run: run((v) => wrap(v, '~~')) },
    { icon: <Code size={15} />, title: `${t('editor.code')} (Ctrl+E)`, run: run((v) => wrap(v, '`')) },
    { icon: <Link size={15} />, title: `${t('editor.link')} (Ctrl+K)`, run: run(insertLink) },
    { icon: <List size={15} />, title: t('editor.bullets'), run: run((v) => prefix(v, '- ')) },
    { icon: <ListOrdered size={15} />, title: t('editor.numbers'), run: run((v) => prefix(v, '1. ')) },
    { icon: <ListChecks size={15} />, title: t('editor.tasks'), run: run((v) => prefix(v, '- [ ] ')) },
    { icon: <Quote size={15} />, title: t('editor.quote'), run: run((v) => prefix(v, '> ')) },
    { icon: <SquareCode size={15} />, title: t('editor.codeBlock'), run: run((v) => insertBlock(v, '```\n$SEL\n```\n', 4)) },
    { icon: <Minus size={15} />, title: t('editor.rule'), run: run((v) => insertBlock(v, '\n---\n', 5)) },
    {
      icon: <Table size={15} />,
      title: t('editor.table'),
      // cursor lands in the first header cell; the table renders once you click outside it
      run: run((v) => insertTable(v, `${t('editor.column')} 1`, `${t('editor.column')} 2`)),
    },
  ]

  return (
    <div className={clsx('lp-editor rounded-lg', !props.readOnly && 'border border-line focus-within:border-accent/70', props.className)}>
      {props.toolbar && !props.readOnly && (
        <div className="flex flex-wrap items-center gap-0.5 border-b border-line px-1.5 py-1">
          {tools.map((tool) => (
            <button
              key={tool.title}
              type="button"
              title={tool.title}
              onMouseDown={(e) => e.preventDefault() /* keep the editor's selection */}
              onClick={tool.run}
              className="rounded p-1.5 text-muted hover:bg-black/5 hover:text-[var(--text)] dark:hover:bg-white/10 cursor-pointer"
            >
              {tool.icon}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2 pr-1 text-xs text-muted">{props.toolbarExtra}</div>
        </div>
      )}
      <div ref={host} className={clsx(!props.readOnly && 'px-3 py-2')} style={{ minHeight: props.minHeight }} onClick={() => !props.readOnly && viewRef.current?.focus()} />
    </div>
  )
})
