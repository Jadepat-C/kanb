import { useQuery } from '@tanstack/react-query'
import { api } from './api'

export interface Department {
  id: string
  name: string
  color: string
  members: number
}

/** Every department (Admin → Departments), for names next to people and lanes. */
export function useDepartments() {
  return useQuery({ queryKey: ['departments'], queryFn: () => api.get<Department[]>('/departments'), staleTime: 60_000 })
}

/** The department's name for a person, or '' (unknown / none). */
export function useDepartmentName() {
  const deps = useDepartments().data
  return (id: string | null | undefined) => (id ? (deps?.find((d) => d.id === id)?.name ?? '') : '')
}
