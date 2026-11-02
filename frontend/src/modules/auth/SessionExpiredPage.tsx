import { useNavigate, useSearchParams } from 'react-router';
import { Clock } from 'lucide-react';
import { useAuth } from '@/app/providers/AuthProvider';
import { Button } from '@/components/ui/Button';
import { usePageTitle } from '@/hooks/usePageTitle';
import { safeReturnTo } from '@/utils/navigation';

export default function SessionExpiredPage() {
  usePageTitle('Session ended');
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { logout } = useAuth();
  const returnTo = safeReturnTo(params.get('returnTo'));

  const signInAgain = async () => {
    await logout(); // clears the stale cookie + local state
    navigate(`/login?returnTo=${encodeURIComponent(returnTo)}`, { replace: true });
  };

  return (
    <div className="text-center sm:text-left">
      <span className="mb-4 inline-flex size-11 items-center justify-center rounded-xl bg-warning-soft text-warning">
        <Clock className="size-5" aria-hidden />
      </span>
      <h1 className="text-2xl font-semibold tracking-tight">Your session has ended</h1>
      <p className="mt-2 text-sm text-muted">
        For your security you were signed out after a period of inactivity, or your access changed. Sign in again to
        continue where you left off.
      </p>
      <Button size="lg" className="mt-6 w-full sm:w-auto" onClick={signInAgain}>Sign in again</Button>
    </div>
  );
}
