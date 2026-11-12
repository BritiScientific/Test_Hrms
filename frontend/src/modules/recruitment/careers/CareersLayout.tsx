import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { Link, Outlet } from 'react-router';
import { Avatar } from '@/components/ui/Avatar';
import type { PublicOrg } from '../types';

interface Ctx { org: PublicOrg | null; setOrg: (o: PublicOrg) => void }
const OrgContext = createContext<Ctx>({ org: null, setOrg: () => undefined });
export const useCareersOrg = () => useContext(OrgContext);

/** Public shell for the careers site: no sign-in, no portal navigation. */
export default function CareersLayout() {
  const [org, setOrg] = useState<PublicOrg | null>(null);
  const value = useMemo(() => ({ org, setOrg }), [org]);
  return (
    <OrgContext.Provider value={value}>
      <div className="flex min-h-dvh flex-col bg-canvas text-ink">
        <header className="border-b border-line bg-surface">
          <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-4 sm:px-6">
            <Link to={org ? `/careers?org=${encodeURIComponent(org.slug)}` : '/careers'} className="flex min-w-0 items-center gap-3">
              {org ? <Avatar name={org.name} src={org.logoUrl} size="lg" square /> : <span className="size-12 rounded-lg bg-slate-100" aria-hidden />}
              <span className="min-w-0"><span className="block truncate text-base font-semibold">{org?.name ?? 'Careers'}</span><span className="block text-xs text-muted">Careers</span></span>
            </Link>
          </div>
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6 sm:py-10"><Outlet /></main>
        <footer className="border-t border-line bg-surface py-5 text-center text-xs text-muted">
          {org ? `© ${new Date().getFullYear()} ${org.name}` : ''}
        </footer>
      </div>
    </OrgContext.Provider>
  );
}

export function CareersMessage({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mx-auto max-w-lg rounded-xl border border-line bg-surface px-6 py-12 text-center shadow-card">
      <h1 className="text-lg font-semibold">{title}</h1>
      {children && <div className="mt-2 text-sm text-muted">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
