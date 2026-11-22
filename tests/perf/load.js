// Load test for Kanb (k6). Run tests/perf/seed.py against the same server first, then:
//   docker run --rm --network host -u "$(id -u)" -v "$PWD/tests/perf:/perf:Z" -e KANB_URL=http://localhost:8080 \
//     grafana/k6 run --summary-export /perf/summary.json /perf/load.js
//
// Three groups at once for about 3 minutes:
//   readers  ramp up to 40 people: board list, the big board (2,000 cards), card details and history, search,
//            the cross-board calendar, notifications
//   writers  10 people: move cards, change priority, comment
//   live     20 people with the big board open over its WebSocket; like a browser tab, each refetches the board when
//            told something changed (LIVE=coalesced, the default, or LIVE=every for the old one-refresh-per-change)
import http from 'k6/http'
import ws from 'k6/ws'
import { check, sleep } from 'k6'
import { Counter } from 'k6/metrics'

const BASE = (__ENV.KANB_URL || 'http://localhost:8080').replace(/\/$/, '')
const seed = JSON.parse(open('./seed.json'))
const liveMessages = new Counter('live_messages')

export const options = {
  scenarios: {
    readers: {
      executor: 'ramping-vus', exec: 'reader', startVUs: 0,
      stages: [{ duration: '30s', target: 20 }, { duration: '2m', target: 40 }, { duration: '30s', target: 0 }],
    },
    writers: { executor: 'constant-vus', exec: 'writer', vus: 10, duration: '3m' },
    live: { executor: 'constant-vus', exec: 'live', vus: 20, duration: '3m' },
  },
  thresholds: {
    'http_req_duration{kind:read}': ['p(95)<800'],
    'http_req_duration{kind:write}': ['p(95)<800'],
    http_req_failed: ['rate<0.01'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  // each simulated person signs in once and stays signed in (k6 would otherwise clear cookies every round)
  noCookiesReset: true,
}

const pick = (a) => a[Math.floor(Math.random() * a.length)]
const headers = { Origin: BASE, 'Content-Type': 'application/json' }
let signedIn = false

function signIn() {
  if (signedIn) return
  const user = seed.users[__VU % seed.users.length]
  const r = http.post(`${BASE}/api/auth/login`, JSON.stringify({ username: user, password: seed.password }), { headers, tags: { kind: 'login' } })
  check(r, { 'signed in': (x) => x.status === 200 })
  signedIn = true
}

const get = (path, name) => http.get(`${BASE}/api${path}`, { headers, tags: { kind: 'read', name } })
const send = (method, path, body, name) => http.request(method, `${BASE}/api${path}`, JSON.stringify(body), { headers, tags: { kind: 'write', name } })

export function reader() {
  signIn()
  const card = pick(seed.big_cards)
  check(get('/boards', 'GET /boards'), { 'boards': (r) => r.status === 200 })
  check(get(`/boards/${seed.big_board}`, 'GET /boards/:big'), { 'big board': (r) => r.status === 200 })
  check(get(`/cards/${card}`, 'GET /cards/:id'), { 'card': (r) => r.status === 200 })
  check(get(`/cards/${card}/timeline`, 'GET /cards/:id/timeline'), { 'timeline': (r) => r.status === 200 })
  check(get(`/search?q=${pick(['design', 'report', 'ลูกค้า', 'deploy', 'api'])}`, 'GET /search'), { 'search': (r) => r.status === 200 })
  const now = new Date()
  const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 7).toISOString()
  check(get(`/calendar?from=${from}&to=${to}`, 'GET /calendar'), { 'calendar': (r) => r.status === 200 })
  check(get(`/boards/${pick(seed.other_boards)}`, 'GET /boards/:other'), { 'other board': (r) => r.status === 200 })
  check(get('/notifications', 'GET /notifications'), { 'notifications': (r) => r.status === 200 })
  sleep(1 + Math.random() * 2)
}

export function writer() {
  signIn()
  const card = pick(seed.big_cards)
  check(send('POST', `/cards/${card}/move`, { list_id: pick(seed.big_lists), index: 0 }, 'POST /cards/:id/move'), { 'move': (r) => r.status === 200 })
  check(send('PATCH', `/cards/${pick(seed.big_cards)}`, { priority: Math.floor(Math.random() * 4) }, 'PATCH /cards/:id'), { 'edit': (r) => r.status === 200 })
  check(send('POST', `/cards/${pick(seed.big_cards)}/comments`, { body: `load test comment ${__VU}-${__ITER}` }, 'POST /cards/:id/comments'), { 'comment': (r) => r.status === 200 })
  sleep(1 + Math.random())
}

export function live() {
  signIn()
  const cookie = Object.entries(http.cookieJar().cookiesForURL(BASE)).map(([k, v]) => `${k}=${v[0]}`).join('; ')
  const url = `${BASE.replace(/^http/, 'ws')}/api/boards/${seed.big_board}/ws`
  // like a browser tab: when told something changed, fetch the board again.
  // LIVE=coalesced (default, what the app does): at most one refresh, folding changes that arrive in the meantime
  // LIVE=every: one refresh per change (the app's behaviour before 0.1.2), for comparison
  const every = __ENV.LIVE === 'every'
  let dirty = false
  const refresh = () => get(`/boards/${seed.big_board}`, 'GET /boards/:big (live refresh)')
  const res = ws.connect(url, { headers: { Origin: BASE, Cookie: cookie } }, (socket) => {
    socket.on('message', (m) => {
      liveMessages.add(1)
      if (String(m).includes('"presence"')) return
      if (every) refresh()
      else dirty = true
    })
    if (!every) socket.setInterval(() => { if (dirty) { dirty = false; refresh() } }, 300)
    socket.setTimeout(() => socket.close(), 60000)
  })
  check(res, { 'live connection': (r) => r && r.status === 101 })
}
