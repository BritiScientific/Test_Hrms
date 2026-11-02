import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate, useSearchParams } from 'react-router';
import { Eye, EyeOff, LogIn } from 'lucide-react';
import { useAuth } from '@/app/providers/AuthProvider';
import { InlineAlert } from '@/components/feedback/States';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { ApiError } from '@/services/api-client';
import { authApi } from '@/services/auth-api';
import type { TenantRequiredDetails } from '@/types/api';
import { usePageTitle } from '@/hooks/usePageTitle';
import { landingPath } from '@/utils/navigation';

const schema = z.object({
  email: z.string().trim().min(1, 'Enter your work email').email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
});
type Values = z.infer<typeof schema>;

export default function LoginPage() {
  usePageTitle('Sign in');
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const returnTo = params.get('returnTo');

  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  });

  const onSubmit = handleSubmit(async ({ email, password }) => {
    setFormError(null);
    try {
      await authApi.login(email, password);
      const me = await refresh();
      if (me) navigate(landingPath(me, returnTo), { replace: true });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'TENANT_REQUIRED') {
        const d = e.details as TenantRequiredDetails;
        // Keep the short-lived selection token in router state only (not storage).
        navigate('/select-organization', { state: { ...d, email, returnTo } });
        return;
      }
      setFormError(loginErrorMessage(e));
    }
  });

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Sign in</h1>
      <p className="mt-1.5 text-sm text-muted">Use your work email to access your organization’s HR portal.</p>

      {params.get('reason') === 'signed-out' && (
        <div className="mt-6"><InlineAlert tone="info">You have been signed out.</InlineAlert></div>
      )}
      {formError && <div className="mt-6"><InlineAlert>{formError}</InlineAlert></div>}

      <form onSubmit={onSubmit} noValidate className="mt-6 space-y-4">
        <Field label="Work email" error={errors.email?.message} required>
          {({ id, describedBy, invalid }) => (
            <Input id={id} type="email" autoComplete="username" inputMode="email" autoFocus
              aria-describedby={describedBy} aria-invalid={invalid} {...register('email')} />
          )}
        </Field>
        <Field label="Password" error={errors.password?.message} required>
          {({ id, describedBy, invalid }) => (
            <div className="relative">
              <Input id={id} type={showPassword ? 'text' : 'password'} autoComplete="current-password"
                className="pr-11" aria-describedby={describedBy} aria-invalid={invalid} {...register('password')} />
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg text-slate-500 hover:text-ink"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showPassword}
              >
                {showPassword ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
              </button>
            </div>
          )}
        </Field>
        <Button type="submit" size="lg" className="w-full" loading={isSubmitting} icon={<LogIn className="size-4" aria-hidden />}>
          Sign in
        </Button>
      </form>

      <p className="mt-8 text-xs leading-relaxed text-muted">
        Sessions end after 15 minutes of inactivity and always after 12 hours. Your administrator can help if you
        cannot sign in.
      </p>
    </div>
  );
}

export function loginErrorMessage(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Something went wrong. Please try again.';
  switch (e.code) {
    case 'INVALID_CREDENTIALS':
      return 'The email or password is incorrect.';
    case 'NO_TENANT':
      return 'Your account is not active in any organization. Contact your administrator.';
    case 'RATE_LIMITED':
      return 'Too many sign-in attempts. Please wait a few minutes and try again.';
    case 'VALIDATION_FAILED':
      return 'Please check the email and password.';
    case 'NETWORK_ERROR':
      return e.message;
    default:
      return 'We could not sign you in right now. Please try again.';
  }
}
