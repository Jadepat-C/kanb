/**
 * Obsidian-style "live preview" for CodeMirror 6: Markdown renders in place, and the raw syntax of an
 * element re-appears only while the cursor is inside it (block markers: while the cursor is on that line).
 * The document itself is always plain Markdown.
 */
import { syntaxTree } from '@codemirror/language'
import { EditorState, Facet, StateEffect, StateField, type Range } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view'

class CheckboxWidget extends WidgetType {
  readonly checked: boolean
  readonly pos: number
  constructor(checked: boolean, pos: number) {
    super()
    this.checked = checked
    this.pos = pos
  }
  eq(o: CheckboxWidget) {
    return o.checked === this.checked && o.pos === this.pos
  }
  toDOM(view: EditorView) {
    const el = document.createElement('input')
    el.type = 'checkbox'
    el.checked = this.checked
    el.className = 'cm-lp-task'
    const ro = view.state.readOnly || !view.contentDOM.isContentEditable
    el.disabled = ro && !view.state.facet(taskToggleWhenReadOnly)
    el.addEventListener('mousedown', (e) => e.preventDefault())
    el.addEventListener('click', (e) => {
      e.preventDefault()
      if (el.disabled) return
      view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: this.checked ? ' ' : 'x' } })
    })
    return el
  }
  ignoreEvent() {
    return true
  }
}

class ImageWidget extends WidgetType {
  readonly src: string
  readonly alt: string
  constructor(src: string, alt: string) {
    super()
    this.src = src
    this.alt = alt
  }
  eq(o: ImageWidget) {
    return o.src === this.src && o.alt === this.alt
  }
  toDOM(view: EditorView) {
    const img = document.createElement('img')
    // line heights were measured before the image loaded; re-measure so the layout doesn't leave gaps
    img.addEventListener('load', () => view.requestMeasure())
    // only same-origin attachments and http(s) images; never javascript:/data:
    if (/^(\/api\/files\/|https?:\/\/)/.test(this.src)) img.src = this.src
    img.alt = this.alt
    img.className = 'cm-lp-img'
    return img
  }
  ignoreEvent() {
    return false
  }
}

class BulletWidget extends WidgetType {
  eq() {
    return true
  }
  toDOM() {
    const s = document.createElement('span')
    s.className = 'cm-lp-bullet'
    s.textContent = '•'
    return s
  }
}

class HrWidget extends WidgetType {
  eq() {
    return true
  }
  toDOM() {
    const s = document.createElement('span')
    s.className = 'cm-lp-hr'
    return s
  }
}

/** Allow ticking checkboxes even when the text itself is read-only (not used by default). */
export const taskToggleWhenReadOnly = Facet.define<boolean, boolean>({ combine: (v) => v.some(Boolean) })

const hide = Decoration.replace({})
const line = (cls: string) => Decoration.line({ class: cls })
const mark = (cls: string, attrs?: Record<string, string>) => Decoration.mark({ class: cls, attributes: attrs })

function build(view: EditorView): DecorationSet {
  const { state } = view
  const focused = view.hasFocus
  const sel = state.selection.ranges
  const touches = (from: number, to: number) => focused && sel.some((r) => r.from <= to && r.to >= from)
  const activeLine = (pos: number) => {
    if (!focused) return false
    const l = state.doc.lineAt(pos)
    return sel.some((r) => r.from <= l.to && r.to >= l.from)
  }
  const out: Range<Decoration>[] = []
  const lineClassAt = (pos: number, cls: string) => out.push(line(cls).range(state.doc.lineAt(pos).from))
  const eachLine = (from: number, to: number, cls: string) => {
    for (let p = from; p <= to; ) {
      const l = state.doc.lineAt(p)
      out.push(line(cls).range(l.from))
      p = l.to + 1
    }
  }

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const n = node.name
        // ----- headings -----
        const h = /^ATXHeading(\d)$/.exec(n)
        if (h) {
          lineClassAt(node.from, `cm-lp-h cm-lp-h${h[1]}`)
          if (!activeLine(node.from)) {
            const m = node.node.getChild('HeaderMark')
            if (m) {
              const end = state.sliceDoc(m.to, m.to + 1) === ' ' ? m.to + 1 : m.to
              out.push(hide.range(m.from, end))
            }
          }
          return
        }
        switch (n) {
          case 'Emphasis':
          case 'StrongEmphasis':
          case 'Strikethrough':
          case 'InlineCode': {
            const cls = { Emphasis: 'cm-lp-em', StrongEmphasis: 'cm-lp-strong', Strikethrough: 'cm-lp-strike', InlineCode: 'cm-lp-code' }[n]
            if (node.to > node.from) out.push(mark(cls).range(node.from, node.to))
            if (!touches(node.from, node.to)) {
              const markName = n === 'InlineCode' ? 'CodeMark' : n === 'Strikethrough' ? 'StrikethroughMark' : 'EmphasisMark'
              for (const c of node.node.getChildren(markName)) out.push(hide.range(c.from, c.to))
            }
            return
          }
          case 'Link': {
            const marks = node.node.getChildren('LinkMark')
            const url = node.node.getChild('URL')
            if (marks.length >= 2 && !touches(node.from, node.to)) {
              const textFrom = marks[0].to
              const textTo = marks[1].from
              if (textTo > textFrom) {
                const href = url ? state.sliceDoc(url.from, url.to) : ''
                out.push(mark('cm-lp-link', { 'data-href': href, title: `${href} — Ctrl+click` }).range(textFrom, textTo))
                out.push(hide.range(node.from, textFrom))
                out.push(hide.range(textTo, node.to))
              }
            } else if (node.to > node.from) {
              out.push(mark('cm-lp-link-src').range(node.from, node.to))
            }
            return false
          }
          case 'URL': {
            // bare autolinks (GFM)
            if (node.node.parent?.name !== 'Link' && node.node.parent?.name !== 'Image') {
              const href = state.sliceDoc(node.from, node.to)
              out.push(mark('cm-lp-link', { 'data-href': href, title: `${href} — Ctrl+click` }).range(node.from, node.to))
            }
            return
          }
          case 'Image': {
            if (!touches(node.from, node.to)) {
              const url = node.node.getChild('URL')
              const marks = node.node.getChildren('LinkMark')
              const alt = marks.length >= 2 ? state.sliceDoc(marks[0].to, marks[1].from) : ''
              if (url) out.push(Decoration.replace({ widget: new ImageWidget(state.sliceDoc(url.from, url.to), alt) }).range(node.from, node.to))
            }
            return false
          }
          case 'Blockquote': {
            eachLine(node.from, node.to, 'cm-lp-quote')
            return
          }
          case 'QuoteMark': {
            if (!activeLine(node.from)) {
              const end = state.sliceDoc(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to
              out.push(hide.range(node.from, end))
            }
            return
          }
          case 'FencedCode':
          case 'CodeBlock': {
            eachLine(node.from, node.to, 'cm-lp-codeblock')
            if (n === 'FencedCode') {
              lineClassAt(node.from, 'cm-lp-codeblock-first')
              lineClassAt(node.to, 'cm-lp-codeblock-last')
              // fences (and the language tag) only show while the cursor is inside the block
              const editing = touches(node.from, node.to)
              const info = node.node.getChild('CodeInfo')
              for (const c of node.node.getChildren('CodeMark')) out.push((editing ? mark('cm-lp-fence') : hide).range(c.from, c.to))
              if (info) out.push((editing ? mark('cm-lp-fence') : mark('cm-lp-lang')).range(info.from, info.to))
            }
            return false
          }
          case 'ListMark': {
            const item = node.node.parent
            const task = item?.getChild('Task')
            const inBullet = item?.parent?.name === 'BulletList'
            if (activeLine(node.from)) return
            if (task) {
              // "- [ ] x": hide "- ", the checkbox widget replaces "[ ]"
              const end = state.sliceDoc(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to
              out.push(hide.range(node.from, end))
            } else if (inBullet) {
              out.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to))
            }
            return
          }
          case 'TaskMarker': {
            const checked = /\[[xX]\]/.test(state.sliceDoc(node.from, node.to))
            if (!touches(node.from, node.to)) {
              out.push(Decoration.replace({ widget: new CheckboxWidget(checked, node.from) }).range(node.from, node.to))
            }
            if (checked) {
              const l = state.doc.lineAt(node.from)
              if (node.to + 1 < l.to) out.push(mark('cm-lp-done').range(node.to + 1, l.to))
            }
            return
          }
          case 'HorizontalRule': {
            if (!activeLine(node.from)) out.push(Decoration.replace({ widget: new HrWidget() }).range(node.from, node.to))
            return
          }
          case 'Table': {
            eachLine(node.from, node.to, 'cm-lp-table')
            return false
          }
        }
      },
    })
  }
  return Decoration.set(out, true)
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = build(view)
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.decorations = build(u.view)
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      // Ctrl/Cmd+click opens rendered links (a plain click places the cursor so the link can be edited)
      mousedown(e) {
        const a = (e.target as HTMLElement).closest('[data-href]') as HTMLElement | null
        if (a && (e.ctrlKey || e.metaKey)) {
          const href = a.dataset.href ?? ''
          if (/^(https?:|mailto:|\/)/.test(href)) window.open(href, '_blank', 'noopener')
          e.preventDefault()
          return true
        }
        return false
      },
    },
  },
)

/** In read-only mode (viewers), plain clicks open links. */
export const readOnlyLinks = EditorView.domEventHandlers({
  click(e, view) {
    if (!view.state.readOnly) return false
    const a = (e.target as HTMLElement).closest('[data-href]') as HTMLElement | null
    if (!a) return false
    const href = a.dataset.href ?? ''
    if (/^(https?:|mailto:|\/)/.test(href)) window.open(href, '_blank', 'noopener')
    return true
  },
})


// ---------- tables ----------
// A rendered table spans several lines, and CodeMirror only accepts such (block) replacements from a
// StateField, not from a view plugin. The field also needs to know whether the editor has focus.

const setFocus = StateEffect.define<boolean>()
const focusField = StateField.define<boolean>({
  create: () => false,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setFocus)) v = e.value
    return v
  },
})

/** Split a table row on unescaped pipes that aren't inside `code`. */
function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  let code = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|'
      i++
    } else if (ch === '`') {
      code = !code
      cur += ch
    } else if (ch === '|' && !code) {
      cells.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  cells.push(cur.trim())
  return cells
}

const SAFE_URL = /^(https?:|mailto:|\/)/i
const INLINE =
  /(`[^`]+`)|(!\[[^\]]*\]\([^)\s]+\))|(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*]+\*\*|__[^_]+__)|(~~[^~]+~~)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)/

/** Minimal inline Markdown for table cells, built as DOM nodes (never innerHTML). */
function renderInline(text: string, parent: HTMLElement) {
  let rest = text
  while (rest) {
    const m = INLINE.exec(rest)
    if (!m) {
      parent.append(rest)
      break
    }
    if (m.index > 0) parent.append(rest.slice(0, m.index))
    const tok = m[0]
    if (m[1]) {
      const c = document.createElement('code')
      c.className = 'cm-lp-code'
      c.textContent = tok.slice(1, -1)
      parent.append(c)
    } else if (m[2]) {
      const [, alt, url] = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(tok)!
      if (/^(\/api\/files\/|https?:\/\/)/.test(url)) {
        const img = document.createElement('img')
        img.src = url
        img.alt = alt
        img.className = 'cm-lp-tableimg'
        parent.append(img)
      } else parent.append(alt)
    } else if (m[3]) {
      const [, label, url] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!
      const a = document.createElement('span')
      a.className = 'cm-lp-link'
      if (SAFE_URL.test(url)) {
        a.dataset.href = url
        a.title = `${url} — Ctrl+click`
      }
      renderInline(label, a)
      parent.append(a)
    } else {
      const el = document.createElement(m[4] ? 'strong' : m[5] ? 's' : 'em')
      renderInline(tok.slice(m[4] || m[5] ? 2 : 1, m[4] || m[5] ? -2 : -1), el)
      parent.append(el)
    }
    rest = rest.slice(m.index + tok.length)
  }
}

class TableWidget extends WidgetType {
  readonly source: string
  constructor(source: string) {
    super()
    this.source = source
  }
  eq(o: TableWidget) {
    return o.source === this.source
  }
  toDOM(view: EditorView) {
    const lines = this.source.split('\n').filter((l) => l.trim())
    const head = splitRow(lines[0] ?? '')
    const align = splitRow(lines[1] ?? '').map((c) =>
      c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : '',
    )
    const wrap = document.createElement('div')
    wrap.className = 'cm-lp-tablewrap'
    const table = document.createElement('table')
    table.className = 'cm-lp-tablerender'
    const thead = table.createTHead().insertRow()
    head.forEach((h, i) => {
      const th = document.createElement('th')
      if (align[i]) th.style.textAlign = align[i]
      renderInline(h, th)
      thead.append(th)
    })
    const tbody = table.createTBody()
    for (const line of lines.slice(2)) {
      const tr = tbody.insertRow()
      const cells = splitRow(line)
      head.forEach((_, i) => {
        const td = tr.insertCell()
        if (align[i]) td.style.textAlign = align[i]
        renderInline(cells[i] ?? '', td)
      })
    }
    wrap.append(table)
    // click → edit the Markdown source (Ctrl+click on a link opens it instead)
    wrap.addEventListener('mousedown', (e) => {
      const link = (e.target as HTMLElement).closest('[data-href]') as HTMLElement | null
      if (link && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        window.open(link.dataset.href, '_blank', 'noopener')
        return
      }
      if (view.state.readOnly) return
      e.preventDefault()
      const pos = view.posAtDOM(wrap)
      view.dispatch({ selection: { anchor: pos } })
      view.focus()
    })
    return wrap
  }
  ignoreEvent() {
    return true
  }
}

function tableDecorations(state: EditorState): DecorationSet {
  const focused = state.field(focusField)
  const sel = state.selection.ranges
  const out: Range<Decoration>[] = []
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'Table') return
      const from = state.doc.lineAt(node.from).from
      const to = state.doc.lineAt(node.to).to
      const editing = focused && sel.some((r) => r.from <= to && r.to >= from)
      if (!editing) out.push(Decoration.replace({ widget: new TableWidget(state.sliceDoc(from, to)), block: true }).range(from, to))
      return false
    },
  })
  return Decoration.set(out, true)
}

const tableField = StateField.define<DecorationSet>({
  create: tableDecorations,
  update(deco, tr) {
    if (tr.docChanged || tr.selection || tr.effects.some((e) => e.is(setFocus)) || syntaxTree(tr.startState) !== syntaxTree(tr.state)) {
      return tableDecorations(tr.state)
    }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f),
})

/** GFM tables render as real tables; the Markdown source shows while the cursor is inside the table. */
export const liveTables = [focusField, EditorView.focusChangeEffect.of((_s, focusing) => setFocus.of(focusing)), tableField]
