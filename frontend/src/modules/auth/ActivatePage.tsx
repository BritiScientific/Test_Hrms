import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Check, KeyRound, X } from 'lucide-react';
import { useAuth } from '@/app/providers/AuthProvider';
import { InlineAlert, LoadingBlock } from '@/components/feedback/States';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { ApiError } from '@/services/api-client';
import { authApi } from '@/services/auth-api';
import { usePageTitle } from '@/hooks/usePageTitle';
import { landingPath } from '@/utils/navigation';
import { cn } from '@/utils/cn';

const RULES = [
  { test: (p: string) => p.length >= 10, label: 'At least 10 characters' },
  { test: (p: string) => /[A-Za-z]/.test(p), label: 'At least one letter' },
  { test: (p: string) => /[0-9]/.test(p), label: 'At least one number' },
];

const newAccount = z.object({
  fullName: z.string().trim().min(1, 'Enter your name').max(200),
  password: z.string().refine((p) => RULES.every((r) => r.test(p)), 'Password does not meet the requirements'),
  confirm: z.string(),
}).refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords do not match' });

const existingAccount = z.object({ password: z.string().min(1, 'Enter your current password') });

/** One-time activation for an invited organization administrator. */
export default function ActivatePage() {
  usePageTitle('Activate your account');
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const info = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => authApi.invitation(token),
    enabled: token.length >= 32,
    retry: false,
    staleTime: Infinity,
  });

  if (token.length < 32 || info.isError) {
    return (
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Activation link not valid</h1>
        <p className="mt-2 text-sm text-muted">
          This link is invalid, has expired or was already used. Ask your platform administrator for a new invitation.
        </p>
        <Link to="/login" className="mt-6 inline-block text-sm font-medium text-primary hover:underline">Go to sign in</Link>
      </div>
    );
  }
  if (info.isPending) return <LoadingBlock rows={5} label="Checking your invitation" />;

  return info.data.accountExists
    ? <ExistingAccountForm token={token} email={info.data.email} org={info.data.organizationName} />
    : <NewAccountForm token={token} email={info.data.email} org={info.data.organizationName} defaultName={info.data.fullName} />;
}

function useActivate(token: string) {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const run = async (password: string, fullName?: string) => {
    setError(null);
    try {
      await authApi.activate(token, password, fullName);
      const me = await refresh();
      if (me) navigate(landingPath(me), { replace: true });
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === 'INVALID_CREDENTIALS') setError('That is not the current password of this account.');
        else if (e.code === 'INVITATION_INVALID') setError('This activation link is no longer valid.');
        else setError(e.message);
      } else setError('Activation failed. Please try again.');
    }
  };
  return { run, error };
}

function Heading({ org, email }: { org: string; email: string }) {
  return (
    <>
      <span className="mb-4 inline-flex size-11 items-center justify-center rounded-xl bg-primary-soft text-primary">
        <KeyRound className="size-5" aria-hidden />
      </span>
      <h1 className="text-2xl font-semibold tracking-tight">Join {org}</h1>
      <p className="mt-1.5 text-sm text-muted">
        You have been invited as the administrator for <span className="font-medium text-ink">{org}</span> using{' '}
        <span className="font-medium text-ink">{email}</span>.
      </p>
    </>
  );
}

function NewAccountForm({ token, email, org, defaultName }: { token: string; email: string; org: string; defaultName: string }) {
  const { run, error } = useActivate(token);
  const { register, handleSubmit, watch, formState: { errors, isSubmitting } } = useForm<z.infer<typeof newAccount>>({
    resolver: zodResolver(newAccount),
    defaultValues: { fullName: defaultName, password: '', confirm: '' },
  });
  const pw = watch('password') ?? '';
  return (
    <div>
      <Heading org={org} email={email} />
      {error && <div className="mt-5"><InlineAlert>{error}</InlineAlert></div>}
      <form noValidate onSubmit={handleSubmit((v) => run(v.password, v.fullName))} className="mt-6 space-y-4">
        <Field label="Your full name" error={errors.fullName?.message} required>
          {({ id, describedBy, invalid }) => (
            <Input id={id} autoComplete="name" aria-describedby={describedBy} aria-invalid={invalid} {...register('fullName')} />
          )}
        </Field>
        <Field label="Create a password" error={errors.password?.message} required>
          {({ id, describedBy, invalid }) => (
            <Input id={id} type="password" autoComplete="new-password" aria-describedby={describedBy} aria-invalid={invalid} {...register('password')} />
          )}
        </Field>
        <ul className="grid gap-1 text-xs" aria-label="Password requirements">
          {RULES.map((r) => {
            const ok = r.test(pw);
            return (
              <li key={r.label} className={cn('flex items-center gap-1.5', ok ? 'text-green-700' : 'text-muted')}>
                {ok ? <Check className="size-3.5" aria-hidden /> : <X className="size-3.5" aria-hidden />}
                {r.label}
                <span className="sr-only">{ok ? '(met)' : '(not met)'}</span>
              </li>
            );
          })}
        </ul>
        <Field label="Confirm password" error={errors.confirm?.message} required>
          {({ id, describedBy, invalid }) => (
            <Input id={id} type="password" autoComplete="new-password" aria-describedby={describedBy} aria-invalid={invalid} {...register('confirm')} />
          )}
        </Field>
        <Button type="submit" size="lg" className="w-full" loading={isSubmitting}>Activate and continue</Button>
      </form>
    </div>
  );
}

function ExistingAccountForm({ token, email, org }: { token: string; email: string; org: string }) {
  const { run, error } = useActivate(token);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<z.infer<typeof existingAccount>>({
    resolver: zodResolver(existingAccount),
  });
  return (
    <div>
      <Heading org={org} email={email} />
      <div className="mt-5">
        <InlineAlert tone="info">
          You already have an HRMS account. Confirm with your current password to add {org} to it. Your password will not change.
        </InlineAlert>
      </div>
      {error && <div className="mt-3"><InlineAlert>{error}</InlineAlert></div>}
      <form noValidate onSubmit={handleSubmit((v) => run(v.password))} className="mt-6 space-y-4">
        <Field label="Current password" error={errors.password?.message} required>
          {({ id, describedBy, invalid }) => (
            <Input id={id} type="password" autoComplete="current-password" aria-describedby={describedBy} aria-invalid={invalid} {...register('password')} />
          )}
        </Field>
        <Button type="submit" size="lg" className="w-full" loading={isSubmitting}>Join {org}</Button>
      </form>
    </div>
  );
}
