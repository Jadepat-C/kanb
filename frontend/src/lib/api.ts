/** Thin fetch wrapper. Errors carry the server's stable `code`, which the UI translates. */
export class ApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string) {
    super(code)
    this.status = status
    this.code = code
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: {} }
  if (body instanceof FormData) {
    init.body = body
  } else if (body !== undefined) {
    init.body = JSON.stringify(body)
    ;(init.headers as Record<string, string>)['Content-Type'] = 'application/json'
  }
  const res = await fetch(`/api${path}`, init)
  if (!res.ok) {
    let code = 'internal'
    try {
      code = (await res.json()).error ?? code
    } catch {
      /* not json */
    }
    if (res.status === 401 && path !== '/auth/login' && path !== '/me') {
      window.dispatchEvent(new Event('kanban:unauthorized'))
    }
    throw new ApiError(res.status, code)
  }
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, b?: unknown) => request<T>('POST', p, b ?? {}),
  patch: <T>(p: string, b: unknown) => request<T>('PATCH', p, b),
  put: <T>(p: string, b: unknown) => request<T>('PUT', p, b),
  del: <T>(p: string, b?: unknown) => request<T>('DELETE', p, b),
}

/** Upload with progress (fetch has no upload progress). */
export function upload<T>(path: string, file: File | Blob, filename: string, onProgress?: (pct: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api${path}`)
    xhr.withCredentials = true
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(Math.round((e.loaded / e.total) * 100))
    xhr.onload = () => {
      let data: { error?: string } = {}
      try {
        data = JSON.parse(xhr.responseText)
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T)
      else reject(new ApiError(xhr.status, data.error ?? (xhr.status === 413 ? 'too_large' : 'internal')))
    }
    xhr.onerror = () => reject(new ApiError(0, 'network'))
    const fd = new FormData()
    fd.append('file', file, filename)
    xhr.send(fd)
  })
}

export const fileUrl = (id: string) => `/api/files/${id}`
