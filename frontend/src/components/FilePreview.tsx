/**
 * In-app attachment preview. Files are fetched through the permission-checked /api/files endpoint and
 * rendered entirely in the browser (nothing is sent to an outside viewer service).
 * Heavy viewers (PDF.js, docx-preview, SheetJS, pptx-preview) are loaded only when needed.
 */
import clsx from 'clsx'
import { ChevronLeft, ChevronRight, Download, FileQuestion, X } from 'lucide-react'
import { Dialog as RDialog } from 'radix-ui'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { fileUrl } from '../lib/api'
import { fmtSize } from '../lib/prefs'
import type { Attachment } from '../lib/types'
import { Markdown } from './Markdown'
import { Spinner } from './ui'

const MAX_PREVIEW = 60 * 1024 * 1024

type Kind = 'image' | 'pdf' | 'docx' | 'sheet' | 'pptx' | 'markdown' | 'text' | 'video' | 'audio' | 'none'

const EXT: Record<string, Kind> = {}
const add = (k: Kind, exts: string) => exts.split(' ').forEach((e) => (EXT[e] = k))
add('image', 'png jpg jpeg gif webp avif bmp svg ico')
add('pdf', 'pdf')
add('docx', 'docx')
add('sheet', 'xlsx xlsm xls ods csv tsv')
add('pptx', 'pptx')
add('markdown', 'md markdown')
add(
  'text',
  'txt log json jsonl xml yaml yml toml ini conf cfg env sql sh bash zsh ps1 bat js mjs cjs ts tsx jsx py rb go rs java kt c h cpp hpp cs php css scss html htm vue svelte dockerfile gitignore properties',
)
add('video', 'mp4 webm mov m4v ogv')
add('audio', 'mp3 wav ogg oga m4a flac aac')

export function previewKind(a: Pick<Attachment, 'filename' | 'content_type'>): Kind {
  const ext = a.filename.toLowerCase().split('.').pop() ?? ''
  if (EXT[ext]) return EXT[ext]
  const ct = a.content_type
  if (ct.startsWith('image/')) return 'image'
  if (ct.startsWith('video/')) return 'video'
  if (ct.startsWith('audio/')) return 'audio'
  if (ct.startsWith('text/')) return 'text'
  return 'none'
}

/** Decode text as UTF-8, falling back to Thai Windows-874 (TIS-620) for legacy files. */
function decodeText(buf: ArrayBuffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return new TextDecoder('windows-874').decode(buf)
  }
}

/** Third-party renderers build DOM from untrusted documents: strip anything executable. */
function scrub(root: HTMLElement) {
  root.querySelectorAll('script, iframe, object, embed, link[rel=import], meta, base, form').forEach((e) => e.remove())
  root.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) {
      const n = attr.name.toLowerCase()
      const v = attr.value.trim().toLowerCase()
      if (n.startsWith('on')) el.removeAttribute(attr.name)
      else if ((n === 'href' || n === 'src' || n === 'xlink:href' || n === 'action') && v.startsWith('javascript:')) el.removeAttribute(attr.name)
    }
    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank')
      el.setAttribute('rel', 'noopener noreferrer')
    }
  })
}

export function FilePreview({ items, index, onIndex, onClose }: { items: Attachment[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const { t } = useTranslation()
  const a = items[index]
  const prev = () => index > 0 && onIndex(index - 1)
  const next = () => index < items.length - 1 && onIndex(index + 1)

  return (
    <RDialog.Root open onOpenChange={(o) => !o && onClose()}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-[60] bg-black/70" />
        <RDialog.Content
          aria-describedby={undefined}
          onKeyDown={(e) => {
            if ((e.target as HTMLElement).closest('input, textarea, select')) return
            if (e.key === 'ArrowLeft') prev()
            if (e.key === 'ArrowRight') next()
          }}
          className="fixed inset-2 z-[60] flex flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl outline-none sm:inset-6"
        >
          <div className="flex items-center gap-2 border-b border-line px-4 py-2">
            <RDialog.Title className="min-w-0 flex-1 truncate text-sm font-semibold">{a.filename}</RDialog.Title>
            <span className="text-xs text-muted">
              {fmtSize(a.size)}
              {items.length > 1 && ` · ${index + 1}/${items.length}`}
            </span>
            {items.length > 1 && (
              <>
                <button onClick={prev} disabled={index === 0} className="rounded p-1.5 text-muted enabled:hover:bg-black/5 disabled:opacity-30 enabled:cursor-pointer dark:enabled:hover:bg-white/10" title="←">
                  <ChevronLeft size={18} />
                </button>
                <button onClick={next} disabled={index === items.length - 1} className="rounded p-1.5 text-muted enabled:hover:bg-black/5 disabled:opacity-30 enabled:cursor-pointer dark:enabled:hover:bg-white/10" title="→">
                  <ChevronRight size={18} />
                </button>
              </>
            )}
            <a href={`${fileUrl(a.id)}?download=1`} className="rounded p-1.5 text-muted hover:bg-black/5 dark:hover:bg-white/10" title={t('preview.download')}>
              <Download size={18} />
            </a>
            <RDialog.Close className="rounded p-1.5 text-muted hover:bg-black/5 dark:hover:bg-white/10" aria-label={t('common.close')}>
              <X size={18} />
            </RDialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-auto bg-app">
            <Body key={a.id} a={a} />
          </div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  )
}

function Body({ a }: { a: Attachment }) {
  const { t } = useTranslation()
  const kind = previewKind(a)
  const [buf, setBuf] = useState<ArrayBuffer | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const tooBig = a.size > MAX_PREVIEW

  useEffect(() => {
    if (kind === 'none' || tooBig) return
    const ctl = new AbortController()
    fetch(`${fileUrl(a.id)}?download=1`, { signal: ctl.signal, credentials: 'same-origin' })
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then(setBuf)
      .catch((e) => e.name !== 'AbortError' && setErr(String(e.message ?? e)))
    return () => ctl.abort()
  }, [a.id, kind, tooBig])

  if (kind === 'none' || tooBig || err) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-muted">
        <FileQuestion size={40} />
        <p>{err ? t('preview.failed') : tooBig ? t('preview.tooBig') : t('preview.unsupported')}</p>
        <a href={`${fileUrl(a.id)}?download=1`} className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white">
          <Download size={15} /> {t('preview.download')}
        </a>
      </div>
    )
  }
  if (!buf)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    )
  switch (kind) {
    case 'image':
      return <ImageView buf={buf} type={a.content_type} name={a.filename} />
    case 'video':
    case 'audio':
      return <MediaView buf={buf} type={a.content_type} kind={kind} />
    case 'pdf':
      return <PdfView buf={buf} onError={setErr} />
    case 'docx':
      return <DocxView buf={buf} onError={setErr} />
    case 'pptx':
      return <PptxView buf={buf} onError={setErr} />
    case 'sheet':
      return <SheetView buf={buf} name={a.filename} onError={setErr} />
    case 'markdown':
      return (
        <div className="mx-auto max-w-3xl bg-surface p-6 sm:my-4 sm:rounded-lg">
          <Markdown source={decodeText(buf)} />
        </div>
      )
    case 'text':
      return <pre className="whitespace-pre-wrap break-words p-4 font-mono text-[13px] leading-relaxed">{decodeText(buf)}</pre>
  }
}

function useBlobUrl(buf: ArrayBuffer, type: string) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    const u = URL.createObjectURL(new Blob([buf], { type }))
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [buf, type])
  return url
}

function ImageView({ buf, type, name }: { buf: ArrayBuffer; type: string; name: string }) {
  // SVG shown through <img> can't run scripts
  const url = useBlobUrl(buf, name.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : type)
  const [actual, setActual] = useState(false)
  if (!url) return null
  return (
    <div className={clsx('flex min-h-full p-4', actual ? 'items-start justify-start' : 'items-center justify-center')}>
      <img
        src={url}
        alt={name}
        onClick={() => setActual(!actual)}
        className={clsx('rounded shadow', actual ? 'max-w-none cursor-zoom-out' : 'max-h-[80vh] max-w-full cursor-zoom-in object-contain')}
      />
    </div>
  )
}

function MediaView({ buf, type, kind }: { buf: ArrayBuffer; type: string; kind: 'video' | 'audio' }) {
  const url = useBlobUrl(buf, type)
  if (!url) return null
  return (
    <div className="flex h-full items-center justify-center p-4">
      {kind === 'video' ? <video src={url} controls className="max-h-full max-w-full rounded" /> : <audio src={url} controls />}
    </div>
  )
}

function PdfView({ buf, onError }: { buf: ArrayBuffer; onError: (e: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pages, setPages] = useState(0)
  useEffect(() => {
    let cancelled = false
    let doc: { destroy: () => unknown } | null = null
    ;(async () => {
      const pdfjs = await import('pdfjs-dist')
      const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
      pdfjs.GlobalWorkerOptions.workerSrc = worker
      const task = pdfjs.getDocument({ data: new Uint8Array(buf.slice(0)), useSystemFonts: true })
      doc = task
      const pdf = await task.promise
      if (cancelled) return
      setPages(pdf.numPages)
      const host = ref.current!
      const width = Math.min(host.clientWidth - 32, 1000)
      for (let i = 1; i <= Math.min(pdf.numPages, 200) && !cancelled; i++) {
        const page = await pdf.getPage(i)
        const base = page.getViewport({ scale: 1 })
        const scale = width / base.width
        const vp = page.getViewport({ scale: scale * devicePixelRatio })
        const canvas = document.createElement('canvas')
        canvas.width = vp.width
        canvas.height = vp.height
        canvas.style.width = `${vp.width / devicePixelRatio}px`
        canvas.className = 'mx-auto mb-4 block bg-white shadow'
        host.appendChild(canvas)
        await page.render({ canvas, viewport: vp }).promise
      }
    })().catch((e) => !cancelled && onError(String(e?.message ?? e)))
    return () => {
      cancelled = true
      doc?.destroy()
    }
  }, [buf, onError])
  return (
    <div>
      {pages > 200 && <p className="p-2 text-center text-xs text-muted">1–200 / {pages}</p>}
      <div ref={ref} className="p-4" />
    </div>
  )
}

function DocxView({ buf, onError }: { buf: ArrayBuffer; onError: (e: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { renderAsync } = await import('docx-preview')
      if (cancelled || !ref.current) return
      ref.current.innerHTML = ''
      await renderAsync(buf, ref.current, undefined, {
        inWrapper: true,
        ignoreLastRenderedPageBreak: true,
        useBase64URL: true, // images as data: URLs (allowed by the CSP), no blob leaks
        renderHeaders: true,
        renderFooters: true,
      })
      if (ref.current) scrub(ref.current)
    })().catch((e) => !cancelled && onError(String(e?.message ?? e)))
    return () => {
      cancelled = true
    }
  }, [buf, onError])
  // docx pages are white paper regardless of theme
  return <div ref={ref} className="docx-host text-black" />
}

function PptxView({ buf, onError }: { buf: ArrayBuffer; onError: (e: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let cancelled = false
    let viewer: { destroy: () => void } | null = null
    ;(async () => {
      const { init } = await import('pptx-preview')
      if (cancelled || !ref.current) return
      const width = Math.min(ref.current.clientWidth - 32, 1100)
      const v = init(ref.current, { width, height: Math.round((width * 9) / 16), mode: 'list' })
      viewer = v
      await v.preview(buf.slice(0))
      if (ref.current) scrub(ref.current)
    })().catch((e) => !cancelled && onError(String(e?.message ?? e)))
    return () => {
      cancelled = true
      viewer?.destroy()
    }
  }, [buf, onError])
  return <div ref={ref} className="pptx-host flex flex-col items-center p-4" />
}

type Grid = { name: string; rows: string[][]; truncated: boolean }

function SheetView({ buf, name, onError }: { buf: ArrayBuffer; name: string; onError: (e: string) => void }) {
  const [sheets, setSheets] = useState<Grid[] | null>(null)
  const [active, setActive] = useState(0)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const XLSX = await import('xlsx')
      const lower = name.toLowerCase()
      const wb =
        lower.endsWith('.csv') || lower.endsWith('.tsv')
          ? XLSX.read(decodeText(buf), { type: 'string', raw: true })
          : XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: true, cellFormula: true, sheetStubs: true })
      // formulas saved without a cached result (e.g. files written by scripts): show the formula itself
      for (const ws of Object.values(wb.Sheets))
        for (const [ref, cell] of Object.entries(ws) as [string, { f?: string; v?: unknown; t?: string; w?: string }][])
          if (!ref.startsWith('!') && cell?.f && (cell.v === undefined || cell.v === '' || cell.t === 'z')) Object.assign(cell, { t: 's', v: `=${cell.f}`, w: `=${cell.f}` })
      const out: Grid[] = wb.SheetNames.map((n) => {
        // rendered as React text nodes (never as HTML), so cell content can't inject markup
        const rows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[n], { header: 1, raw: false, defval: '', blankrows: true })
        const truncated = rows.length > 2000 || rows.some((r) => r.length > 200)
        return { name: n, rows: rows.slice(0, 2000).map((r) => r.slice(0, 200).map((c) => String(c ?? ''))), truncated }
      })
      if (!cancelled) setSheets(out)
    })().catch((e) => !cancelled && onError(String(e?.message ?? e)))
    return () => {
      cancelled = true
    }
  }, [buf, name, onError])
  if (!sheets)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    )
  const s = sheets[active]
  const cols = Math.max(1, ...s.rows.map((r) => r.length))
  const colName = (i: number) => {
    let n = ''
    for (i++; i > 0; i = Math.floor((i - 1) / 26)) n = String.fromCharCode(65 + ((i - 1) % 26)) + n
    return n
  }
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="border-collapse bg-surface text-[13px]">
          <thead className="sticky top-0 z-10">
            <tr>
              <th className="sticky left-0 z-20 border border-line bg-surface-2 px-2" />
              {Array.from({ length: cols }, (_, i) => (
                <th key={i} className="border border-line bg-surface-2 px-2 py-0.5 font-medium text-muted">
                  {colName(i)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {s.rows.map((r, ri) => (
              <tr key={ri}>
                <td className="sticky left-0 border border-line bg-surface-2 px-2 text-right text-muted">{ri + 1}</td>
                {Array.from({ length: cols }, (_, ci) => (
                  <td key={ci} className="max-w-[320px] truncate border border-line px-2 py-0.5" title={r[ci] ?? ''}>
                    {r[ci] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {s.truncated && <p className="p-2 text-xs text-muted">2000 × 200 …</p>}
      </div>
      {sheets.length > 1 && (
        <div className="flex gap-1 overflow-x-auto border-t border-line bg-surface px-2 py-1">
          {sheets.map((sh, i) => (
            <button
              key={sh.name}
              onClick={() => setActive(i)}
              className={clsx('rounded px-3 py-1 text-xs cursor-pointer', i === active ? 'bg-accent text-white' : 'text-muted hover:bg-black/5 dark:hover:bg-white/10')}
            >
              {sh.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
