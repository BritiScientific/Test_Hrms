import { Outlet } from 'react-router';
import { CheckCircle2 } from 'lucide-react';

/** Split layout for sign-in screens: brand panel on large screens, single column on phones. */
export function AuthLayout() {
  return (
    <div className="grid min-h-dvh bg-canvas lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <aside className="relative hidden overflow-hidden bg-slate-900 text-white lg:flex lg:flex-col lg:justify-between lg:p-12 3xl:p-16">
        <div className="pointer-events-none absolute -right-24 -top-24 size-96 rounded-full bg-primary/30 blur-3xl" aria-hidden />
        <div className="relative flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-primary text-lg font-bold">H</span>
          <span className="text-lg font-semibold tracking-tight">HRMS Portal</span>
        </div>
        <div className="relative max-w-md">
          <h2 className="text-3xl font-semibold tracking-tight 3xl:text-4xl">People operations, one secure workspace.</h2>
          <ul className="mt-8 space-y-3 text-slate-300">
            {['Each organization’s data is isolated at the database level', 'Fine-grained roles and permissions', 'Every administrative change is audited'].map((t) => (
              <li key={t} className="flex gap-3">
                <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-blue-400" aria-hidden />
                <span>{t}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-sm text-slate-400">© {new Date().getFullYear()} HRMS</p>
      </aside>
      <main className="flex min-w-0 items-center justify-center px-4 py-10 sm:px-6">
        <div className="w-full max-w-md">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <span className="flex size-9 items-center justify-center rounded-xl bg-primary font-bold text-white">H</span>
            <span className="font-semibold">HRMS Portal</span>
          </div>
          <Outlet />
        </div>
      </main>
    </div>
  );
}
