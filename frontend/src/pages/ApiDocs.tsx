/** /help/api: the API reference (docs/api.md), with this server's address filled in. */
import { ArrowLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Markdown } from '../components/Markdown'
import source from '../../../docs/api.md?raw'

export function ApiDocs() {
  const { t } = useTranslation()
  const text = source.replaceAll('https://kanb.example.com', location.origin)
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
