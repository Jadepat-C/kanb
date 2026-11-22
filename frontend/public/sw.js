// Service worker: shows browser notifications sent by the Kanb server (Web Push) and opens the card on click.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { title: 'Kanb', body: event.data ? event.data.text() : '' }
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Kanb', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag || undefined,
      renotify: !!data.tag,
      data: { url: data.url || '/' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL(event.notification.data?.url || '/', self.location.origin)
  // only ever open our own pages
  const target = url.origin === self.location.origin ? url.href : self.location.origin + '/'
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const w of wins) {
        if (new URL(w.url).origin === self.location.origin && 'focus' in w) {
          await w.focus()
          if ('navigate' in w) return w.navigate(target)
          return
        }
      }
      return self.clients.openWindow(target)
    })(),
  )
})
