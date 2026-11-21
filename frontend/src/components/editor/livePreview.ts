/**
 * Obsidian-style "live preview" for CodeMirror 6: Markdown renders in place, and the raw syntax of an
 * element re-appears only while the cursor is inside it (block markers: while the cursor is on that line).
 * The document itself is always plain Markdown.
 */
import { syntaxTree } from '@codemirror/language'
import { Facet, type Range } from '@codemirror/state'
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

