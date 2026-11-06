import { useState, useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate, useSearchParams } from 'react-router';
import { Eye, EyeOff } from 'lucide-react';
import { useAuth } from '@/app/providers/AuthProvider';
import { InlineAlert } from '@/components/feedback/States';
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
  const [remember, setRemember] = useState(false);
  const returnTo = params.get('returnTo');

  const { register, handleSubmit, watch, formState: { errors, isSubmitting } } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  });

  const passwordValue = watch('password') || '';

  // Calculate password strength level (0 to 3)
  const strengthLevel = useMemo(() => {
    if (!passwordValue) return 0;
    let score = 0;
    if (passwordValue.length >= 6) score++;
    if (passwordValue.length >= 10 && /[A-Z]/.test(passwordValue) && /[0-9]/.test(passwordValue)) score++;
    if (passwordValue.length >= 12 && /[^A-Za-z0-9]/.test(passwordValue)) score++;
    return Math.max(1, Math.min(3, score));
  }, [passwordValue]);

  const strengthLabel = useMemo(() => {
    if (!passwordValue) return '';
    if (strengthLevel === 1) return 'Too weak';
    if (strengthLevel === 2) return 'Could be stronger';
    return 'Strong password';
  }, [passwordValue, strengthLevel]);

  const onSubmit = handleSubmit(async ({ email, password }) => {
    setFormError(null);
    try {
      await authApi.login(email, password);
      const me = await refresh();
      if (me) navigate(landingPath(me, returnTo), { replace: true });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'TENANT_REQUIRED') {
        const d = e.details as TenantRequiredDetails;
        navigate('/select-organization', { state: { ...d, email, returnTo } });
        return;
      }
      setFormError(loginErrorMessage(e));
    }
  });

  return (
    <div className="">
      <h1 className="mb-0 font-font-1 text-left text-xl sm:text-2xl font-bold tracking-[0em] text-gray-800">
        Welcome Back
      </h1>
      <p className="text-sm text-gray-500 mb-6 sm:mb-9 ml-1 font-font-4 tracking-wider">Log in to Your HRMS Portal</p>

      {params.get('reason') === 'signed-out' && (
        <div className="mb-5">
          <InlineAlert tone="info">You have been signed out.</InlineAlert>
        </div>
      )}
      {formError && (
        <div className="mb-5">
          <InlineAlert>{formError}</InlineAlert>
        </div>
      )}

      <form onSubmit={onSubmit} noValidate className="space-y-4 mt-6 sm:mt-8 font-font-4">
        {/* Email */}
        <div className="">
          <input
            type="email"
            placeholder="Enter email"
            autoComplete="username"
            autoFocus
            className="w-full rounded-[4px] border-2 border-gray-400 px-4 py-3 text-base sm:text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-cyan-500/20"
            {...register('email')}
          />
          {errors.email && (
            <p className="mt-1.5 text-xs text-red-500">{errors.email.message}</p>
          )}
        </div>

        {/* Password with Strength Indicator */}
        <div>
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              placeholder="Password"
              autoComplete="current-password"
              className="w-full rounded-[4px] border-2 border-gray-400 px-4 py-3 pr-11 text-base sm:text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-cyan-500/20"
              {...register('password')}
            />
            <button
              type="button"
              onClick={() => setShowPassword((s) => !s)}
              className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-gray-400 hover:text-gray-600"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>

          {/* Strength Indicator Bars & Label */}
          {/* Strength Indicator Bars & Label */}
          {passwordValue && (
            <div className="mt-2">
              <div className="flex items-center gap-2">
                <div
                  className={`h-1.5 flex-1 rounded-full transition-all duration-300 ${
                    strengthLevel >= 1 ? 'bg-[#ff5c75]' : 'bg-[#e5e7eb]'
                  }`}
                />
                <div
                  className={`h-1.5 flex-1 rounded-full transition-all duration-300 ${
                    strengthLevel >= 2 ? 'bg-[#ffb547]' : 'bg-[#e5e7eb]'
                  }`}
                />
                <div
                  className={`h-1.5 flex-1 rounded-full transition-all duration-300 ${
                    strengthLevel >= 3 ? 'bg-[#3cc1ed]' : 'bg-[#e5e7eb]'
                  }`}
                />
                <span
                  className={`text-xs font-medium ml-1 sm:ml-2 whitespace-nowrap ${
                    strengthLevel === 1
                      ? 'text-[#ff5c75]'
                      : strengthLevel === 2
                      ? 'text-[#ffb547]'
                      : 'text-[#3cc1ed]'
                  }`}
                >
                  {strengthLabel}
                </span>
              </div>
            </div>
          )}

          {errors.password && (
            <p className="mt-1.5 text-xs text-red-500">{errors.password.message}</p>
          )}
        </div>

        {/* Remember me */}
        <div>
            <a href="#" className="inline-block py-1 text-sm text-right text-blue-500 hover:underline">
              Forgot password
            </a>
        </div>

        {/* Sign in button */}
        <button
          type="submit"
          disabled={isSubmitting}
          className="mt-2 w-full rounded-[4px] bg-blue-700 py-3.5 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-60"
        >
          {isSubmitting ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
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