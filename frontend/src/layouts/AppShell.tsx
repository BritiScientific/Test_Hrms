import { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router';
import { X } from 'lucide-react';
import { Sidebar, type SidebarVariant } from '@/components/navigation/Sidebar';
import { Topbar } from '@/components/navigation/Topbar';
import { cn } from '@/utils/cn';

const COLLAPSE_KEY = 'hrms.sidebar.collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Responsive application shell shared by the portal and settings areas:
 *  - < 1024px: sidebar is an off-canvas drawer (native <dialog>: focus trap + Esc)
 *  - ≥ 1024px: fixed sidebar, collapsible to an icon rail (remembered per browser)
 *  - content is a centred, max-width workspace that never stretches on TVs.
 */
export function AppShell({ variant, onBack }: { variant: SidebarVariant; onBack?: () => void }) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawer = useRef<HTMLDialogElement>(null);
  const location = useLocation();

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
      /* storage unavailable: preference just isn't remembered */
    }
  }, [collapsed]);

  useEffect(() => {
    const d = drawer.current;
    if (!d) return;
    if (drawerOpen && !d.open) d.showModal?.();
    if (!drawerOpen && d.open) d.close?.();
  }, [drawerOpen]);

  // Close the drawer on navigation.
  useEffect(() => setDrawerOpen(false), [location.pathname]);

  return (
    <div className="min-h-dvh bg-canvas" style={{ ['--sidebar-width' as string]: collapsed ? '5rem' : '16rem' }}>
      <a
        href="#main"
        className="sr-only z-[70] rounded-lg bg-primary px-4 py-2 text-white focus:not-sr-only focus:fixed focus:left-4 focus:top-3"
      >
        Skip to content
      </a>

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 hidden flex-col border-r border-line bg-surface transition-[width] duration-200 lg:flex',
          collapsed ? 'w-20' : 'w-64',
        )}
      >
        <Sidebar variant={variant} collapsed={collapsed} onBack={onBack} />
      </aside>

      <dialog
        ref={drawer}
        aria-label={variant === 'main' ? 'Navigation' : 'Settings navigation'}
        onCancel={(e) => {
          e.preventDefault();
          setDrawerOpen(false);
        }}
        onClick={(e) => {
          if (e.target === drawer.current) setDrawerOpen(false);
        }}
        className="m-0 h-dvh max-h-none w-72 max-w-[85vw] border-r border-line bg-surface p-0 shadow-pop lg:hidden"
      >
        {drawerOpen && (
          <div className="relative h-full">
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              className="absolute right-2 top-3 z-10 inline-flex size-10 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
              aria-label="Close navigation"
            >
              <X className="size-5" aria-hidden />
            </button>
            <Sidebar variant={variant} onNavigate={() => setDrawerOpen(false)} onBack={onBack} />
          </div>
        )}
      </dialog>

      <div className={cn('min-w-0 transition-[padding] duration-200', collapsed ? 'lg:pl-20' : 'lg:pl-64')}>
        <Topbar
          onOpenNav={() => setDrawerOpen(true)}
          collapsed={collapsed}
          onToggleCollapsed={() => setCollapsed((c) => !c)}
          inSettings={variant === 'settings'}
        />
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-workspace px-4 py-5 outline-none sm:px-6 sm:py-6 lg:px-8 2xl:px-10 safe-bottom">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
