/** /help/api: the API reference (docs/api.md), with this server's address filled in. */
import { ArrowLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Markdown } from '../components/Markdown'
import { useMe } from '../lib/auth'
import source from '../../../docs/api.md?raw'

export function ApiDocs() {
  const { t } = useTranslation()
  const { data: me } = useMe()
  let text = source.replaceAll('https://kanb.example.com', location.origin)
  // the admin endpoints only answer super admins: everyone else doesn't need them in the way (the server checks
  // every call regardless, and docs/api.md keeps the full reference)
  if (!me?.is_super_admin) text = withoutSection(text, '### Administration')
  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <Link to="/profile?tab=api" className="mb-4 inline-flex items-center gap-1 text-sm text-accent hover:underline">
        <ArrowLeft size={14} /> {t('tokens.title')}
      </Link>
      <article className="rounded-xl border border-line bg-surface p-5 sm:p-8 [&_table]:block [&_table]:overflow-x-auto">
        <Markdown source={text} className="prose-code:before:content-none prose-code:after:content-none" />
      </article>
    </div>
  )
}

/** `md` without the section whose heading starts with `heading` (up to the next heading of the same level). */
function withoutSection(md: string, heading: string) {
  const start = md.indexOf(`\n${heading}`)
  if (start < 0) return md
  const level = heading.split(' ')[0]
  const next = md.indexOf(`\n${level} `, start + 1)
  return md.slice(0, start) + (next < 0 ? '\n' : md.slice(next))
}
