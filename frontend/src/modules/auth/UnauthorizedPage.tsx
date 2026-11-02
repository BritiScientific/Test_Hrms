import { Link, useNavigate } from 'react-router';
import { ShieldAlert } from 'lucide-react';
import { Button, ButtonLink } from '@/components/ui/Button';
import { usePageTitle } from '@/hooks/usePageTitle';

/** Access-denied state. `inline` renders inside the portal shell (navigation stays usable). */
export function AccessDenied({ inline, required }: { inline?: boolean; required?: readonly string[] }) {
  const navigate = useNavigate();
  usePageTitle('Access denied');
  return (
    <div className={inline ? 'flex justify-center py-12 sm:py-20' : 'flex min-h-dvh items-center justify-center bg-canvas px-4'}>
      <div className="max-w-md text-center">
        <span className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-danger-soft text-danger">
          <ShieldAlert className="size-6" aria-hidden />
        </span>
        <h1 className="text-xl font-semibold text-ink">You don’t have access to this page</h1>
        <p className="mt-2 text-sm text-muted">
          Your current roles don’t include the permission this page needs. If you think you should have access, ask
          your organization administrator.
        </p>
        {required && required.length > 0 && (
          <p className="mt-3 text-xs text-slate-500">
            Requires one of: {required.map((c) => <code key={c} className="mx-0.5 rounded bg-slate-100 px-1 py-0.5 font-mono">{c}</code>)}
          </p>
        )}
        <div className="mt-6 flex flex-col justify-center gap-2 sm:flex-row">
          <Button variant="outline" onClick={() => navigate(-1)}>Go back</Button>
          <ButtonLink to="/dashboard">Go to dashboard</ButtonLink>
        </div>
      </div>
    </div>
  );
}

export default function UnauthorizedPage() {
  return <AccessDenied />;
}

export function NotFoundPage() {
  usePageTitle('Page not found');
  return (
    <div className="flex justify-center py-16">
      <div className="max-w-md text-center">
        <p className="text-sm font-semibold text-primary">404</p>
        <h1 className="mt-1 text-xl font-semibold">Page not found</h1>
        <p className="mt-2 text-sm text-muted">The page you are looking for doesn’t exist or is not part of this release.</p>
        <Link to="/dashboard" className="mt-6 inline-block text-sm font-medium text-primary hover:underline">Back to dashboard</Link>
      </div>
    </div>
  );
}
