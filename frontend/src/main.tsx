import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, Navigate, RouterProvider, useLocation } from 'react-router'
import { Layout } from './components/Layout'
import { DialogHost } from './components/dialogs'
import { Toaster } from './components/toast'
import { Spinner } from './components/ui'
import './index.css'
import { useMe } from './lib/auth'
import './lib/i18n'
import { Admin } from './pages/Admin'
import { ForceChangePassword, ForgotPassword, ResetPassword } from './pages/AuthPages'
import { BoardPage } from './pages/Board'
import { CalendarPage } from './pages/CalendarPage'
import { TemplatesPage } from './pages/Templates'
import { Boards } from './pages/Boards'
import { Login } from './pages/Login'
import { Profile } from './pages/Profile'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: (n, e) => (e as { status?: number }).status === undefined && n < 2, refetchOnWindowFocus: true },
  },
})

function RequireAuth({ children }: { children: ReactNode }) {
  const { data: me, isLoading } = useMe()
  const loc = useLocation()
  if (isLoading)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    )
  if (!me) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />
  // an admin-set password must be replaced before anything else
  if (me.must_change_password) return <ForceChangePassword me={me} />
  return <>{children}</>
}

const router = createBrowserRouter([
  { path: '/login', element: <Login /> },
  { path: '/forgot-password', element: <ForgotPassword /> },
  { path: '/reset-password', element: <ResetPassword /> },
  {
    element: (
      <RequireAuth>
        <Layout />
      </RequireAuth>
    ),
    children: [
      { path: '/', element: <Boards /> },
      { path: '/b/:boardId', element: <BoardPage /> },
      { path: '/calendar', element: <CalendarPage /> },
      { path: '/templates', element: <TemplatesPage /> },
      { path: '/admin', element: <Admin /> },
      { path: '/profile', element: <Profile /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
      <DialogHost />
    </QueryClientProvider>
  </StrictMode>,
)
