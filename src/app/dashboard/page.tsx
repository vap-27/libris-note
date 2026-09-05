import { redirect } from 'next/navigation'

/** /dashboard is the observability home — the health dashboard. */
export default function DashboardAlias() {
  redirect('/health')
}
