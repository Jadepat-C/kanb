/** Boards page → Import: make a new board from a Trello / Wekan / Kanb export or a CSV file. */
import { useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { AlertTriangle, CheckCircle2, FileUp, UserX } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { api } from '../lib/api'
import { errorText } from '../lib/i18n'
import { fmtDate } from '../lib/prefs'
import { toastSuccess } from './toast'
import { Button, Dialog, Field, Input, Spinner } from './ui'

const FIELDS = [
  'title',
  'column',
  'description',
  'status',
  'done',
  'labels',
  'assignees',
  'priority',
  'start',
  'due',
  'finished',
  'created',
  'archived',
  'number',
] as const
type CsvField = (typeof FIELDS)[number]
type CsvMap = Partial<Record<CsvField, number | null>> & { day_first: boolean }

interface Preview {
  format: 'trello' | 'wekan' | 'kanb' | 'zip' | 'csv'
  source: string
  name: string
  lists: number
  cards: number
  archived_cards: number
  labels: number
  comments: number
  files: number
  people: {
    name: string
    username: string | null
    email: string | null
    account: { id: string; display_name: string; username: string } | null
  }[]
  warnings: string[]
  csv: { headers: string[]; rows: string[][]; map: CsvMap } | null
  sample: {
    title: string
    column: string | null
    due_at: string | null
    start_at: string | null
    labels: string[]
    assignees: string[]
    done: boolean
  }[]
}

function warningText(t: TFunction, w: string) {
  const [key, n] = w.split(':')
  return t(`import.warn.${key}`, { count: Number(n) || 0 })
}

export function ImportBoard({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const nav = useNavigate()
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [map, setMap] = useState<CsvMap | null>(null)
  const [name, setName] = useState('')
  const [addMembers, setAddMembers] = useState(true)
  const [doneColumns, setDoneColumns] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const reset = () => {
    setFile(null)
    setPreview(null)
    setMap(null)
    setErr('')
    setName('')
  }
  useEffect(() => {
    if (!open) reset()
  }, [open])

  const send = (path: string, f: File, options: Record<string, unknown>) => {
    const fd = new FormData()
    fd.append('options', JSON.stringify(options))
    fd.append('file', f, f.name)
    return api.post<unknown>(path, fd)
  }
  const look = async (f: File, csv: CsvMap | null) => {
    setBusy(true)
    setErr('')
    try {
      const p = (await send('/import/preview', f, csv ? { csv } : {})) as Preview
      setPreview(p)
      if (p.csv) setMap(p.csv.map)
      setName((n) => n || p.name)
    } catch (e) {
      setPreview(null)
      setErr(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const choose = (f: File | undefined) => {
    if (!f) return
    reset()
    setFile(f)
    look(f, null)
  }
  // CSV: show the effect of a changed column choice
  const remap = (m: CsvMap) => {
    setMap(m)
    if (file) look(file, m)
  }
  const run = async () => {
    if (!file) return
    setBusy(true)
    setErr('')
    try {
      const r = (await send('/import', file, { name, add_members: addMembers, done_columns: doneColumns, ...(map ? { csv: map } : {}) })) as {
        board_id: string
        cards: number
        warnings: string[]
      }
      qc.invalidateQueries({ queryKey: ['boards'] })
      toastSuccess(t('import.done', { count: r.cards }))
      onOpenChange(false)
      nav(`/b/${r.board_id}`)
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const matched = preview?.people.filter((p) => p.account).length ?? 0
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('import.title')} wide>
      <div className="space-y-4 p-5">
        <button
          type="button"
          onClick={() => input.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            choose(e.dataTransfer.files[0])
          }}
          className="flex w-full flex-col items-center gap-1.5 rounded-lg border-2 border-dashed border-line px-4 py-6 text-center text-sm hover:border-accent/60 cursor-pointer"
        >
          <FileUp size={22} className="text-muted" />
          <span className="font-medium">{file ? file.name : t('import.choose')}</span>
          <span className="text-xs text-muted">{t('import.formats')}</span>
        </button>
        <input
          ref={input}
          type="file"
          accept=".json,.zip,.csv,.tsv,.txt,application/json,application/zip,text/csv"
          hidden
          onChange={(e) => {
            choose(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        {!file && (
          <details className="text-sm text-muted">
            <summary className="cursor-pointer">{t('import.howTitle')}</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>{t('import.howTrello')}</li>
              <li>{t('import.howWekan')}</li>
              <li>{t('import.howKanb')}</li>
              <li>{t('import.howCsv')}</li>
              <li>{t('import.howOther')}</li>
            </ul>
          </details>
        )}
        {busy && !preview && (
          <div className="flex justify-center py-4">
            <Spinner />
          </div>
        )}
        {err && (
          <p className="flex items-start gap-1.5 text-sm text-red-600">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {err}
          </p>
        )}
        {preview && (
          <div className={clsx('space-y-4', busy && 'opacity-60')}>
            <p className="text-sm">
              {t('import.found', {
                source: preview.source,
                lists: preview.lists,
                cards: preview.cards,
                labels: preview.labels,
                comments: preview.comments,
              })}
              {preview.archived_cards > 0 && ` ${t('import.archived', { count: preview.archived_cards })}`}
              {preview.files > 0 && ` ${t('import.files', { count: preview.files })}`}
            </p>
            {preview.warnings.map((w) => (
              <p
                key={w}
                className="flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-2 text-xs text-amber-800 dark:text-amber-300"
              >
                <AlertTriangle size={14} className="mt-px shrink-0" /> {warningText(t, w)}
              </p>
            ))}
            {preview.csv && map && <CsvColumns headers={preview.csv.headers} map={map} onChange={remap} />}
            {preview.sample.length > 0 && (
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full text-left text-xs">
                  <thead className="bg-surface-2 text-muted">
                    <tr>
                      <th className="px-2 py-1.5 font-medium">{t('import.f.title')}</th>
                      <th className="px-2 py-1.5 font-medium">{t('import.f.column')}</th>
                      <th className="px-2 py-1.5 font-medium">{t('import.f.due')}</th>
                      <th className="px-2 py-1.5 font-medium">{t('import.f.labels')}</th>
                      <th className="px-2 py-1.5 font-medium">{t('import.f.assignees')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.sample.map((c, i) => (
                      <tr key={i} className="border-t border-line">
                        <td className={clsx('max-w-56 truncate px-2 py-1.5', c.done && 'line-through text-muted')}>{c.title}</td>
                        <td className="px-2 py-1.5">{c.column}</td>
                        <td className="whitespace-nowrap px-2 py-1.5">{c.due_at ? fmtDate(c.due_at, true) : ''}</td>
                        <td className="max-w-40 truncate px-2 py-1.5">{c.labels.join(', ')}</td>
                        <td className="max-w-40 truncate px-2 py-1.5">{c.assignees.join(', ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {preview.people.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold">{t('import.people', { matched, total: preview.people.length })}</h3>
                <ul className="max-h-40 space-y-1 overflow-y-auto text-sm">
                  {preview.people.map((p, i) => (
                    <li key={i} className="flex items-center gap-2">
                      {p.account ? (
                        <CheckCircle2 size={14} className="shrink-0 text-green-600" />
                      ) : (
                        <UserX size={14} className="shrink-0 text-muted" />
                      )}
                      <span className="truncate">{p.name || p.username || p.email}</span>
                      <span className="truncate text-xs text-muted">
                        {p.account ? `→ ${p.account.display_name} (@${p.account.username})` : t('import.noAccount')}
                      </span>
                    </li>
                  ))}
                </ul>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={addMembers}
                    onChange={(e) => setAddMembers(e.target.checked)}
                    className="mt-1 accent-[var(--color-accent)]"
                  />
                  <span>
                    {t('import.addMembers')}
                    <span className="block text-xs text-muted">{t('import.addMembersHint')}</span>
                  </span>
                </label>
              </div>
            )}
            {preview.format !== 'kanb' && preview.format !== 'zip' && (
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={doneColumns} onChange={(e) => setDoneColumns(e.target.checked)} className="mt-1 accent-[var(--color-accent)]" />
                <span>
                  {t('import.doneColumns')}
                  <span className="block text-xs text-muted">{t('import.doneColumnsHint')}</span>
                </span>
              </label>
            )}
            <Field label={t('import.boardName')}>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
            </Field>
            <p className="text-xs text-muted">{t('import.quiet')}</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" onClick={run} disabled={busy || preview.cards + preview.lists === 0}>
                {busy ? <Spinner /> : t('import.go', { count: preview.cards })}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  )
}

/** CSV: which spreadsheet column holds which card field. */
function CsvColumns({ headers, map, onChange }: { headers: string[]; map: CsvMap; onChange: (m: CsvMap) => void }) {
  const { t } = useTranslation()
  return (
    <div className="space-y-2 rounded-lg border border-line p-3">
      <h3 className="text-sm font-semibold">{t('import.csvTitle')}</h3>
      <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <label key={f} className="flex items-center gap-2 text-sm">
            <span className="w-28 shrink-0 text-muted">{t(`import.f.${f}`)}</span>
            <select
              value={map[f] ?? ''}
              onChange={(e) => onChange({ ...map, [f]: e.target.value === '' ? null : Number(e.target.value) })}
              className="h-8 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-sm"
            >
              <option value="">{f === 'title' ? t('import.firstColumn') : '—'}</option>
              {headers.map((h, i) => (
                <option key={i} value={i}>
                  {h || `#${i + 1}`}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <label className="flex items-center gap-2 text-sm">
        {t('import.dateOrder')}
        <select
          value={map.day_first ? 'd' : 'm'}
          onChange={(e) => onChange({ ...map, day_first: e.target.value === 'd' })}
          className="h-8 rounded-md border border-line bg-surface px-2 text-sm"
        >
          <option value="d">{t('import.dayFirst')}</option>
          <option value="m">{t('import.monthFirst')}</option>
        </select>
      </label>
    </div>
  )
}
