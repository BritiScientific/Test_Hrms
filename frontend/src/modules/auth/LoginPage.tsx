import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate, useSearchParams } from 'react-router';
import { Eye, EyeOff, ChevronLeft, ChevronRight } from 'lucide-react';
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

const carouselSlides = [
  {
    title: 'Quality Code and Easy Customizability',
    description: 'There are many variations of passages of Lorem Ipsum available.',
    illustration: (
      <svg className="h-64 w-full" viewBox="0 0 500 350" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="50" y="40" width="400" height="260" rx="8" fill="#2E3440" />
        <rect x="50" y="40" width="400" height="30" rx="8" fill="#3B4252" />
        <circle cx="70" cy="55" r="4" fill="#BF616A" />
        <circle cx="85" cy="55" r="4" fill="#EBCB8B" />
        <circle cx="100" cy="55" r="4" fill="#A3BE8C" />
        <path d="M120 120 L80 160 L120 200" stroke="#E5E9F0" strokeWidth="12" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M180 120 L220 160 L180 200" stroke="#E5E9F0" strokeWidth="12" strokeLinecap="round" strokeLinejoin="round" />
        <line x1="260" y1="120" x2="420" y2="120" stroke="#4C566A" strokeWidth="6" strokeLinecap="round" />
        <line x1="260" y1="145" x2="380" y2="145" stroke="#4C566A" strokeWidth="6" strokeLinecap="round" />
        <line x1="260" y1="170" x2="400" y2="170" stroke="#4C566A" strokeWidth="6" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    title: 'People Operations, One Secure Workspace',
    description: 'Isolated organization data at database level with fine-grained roles & permissions.',
    illustration: (
      <svg className="h-64 w-full" viewBox="0 0 500 350" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="100" y="50" width="300" height="240" rx="12" fill="#3B4252" />
        <circle cx="250" cy="140" r="45" fill="#5E81AC" />
        <path d="M170 250 C170 200 330 200 330 250" fill="#81A1C1" />
        <circle cx="370" cy="80" r="24" fill="#A3BE8C" />
        <path d="M360 80 L368 88 L382 72" stroke="#FFF" strokeWidth="4" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    title: 'Complete Audit & Security Oversight',
    description: 'Every administrative change is recorded with robust security compliance.',
    illustration: (
      <svg className="h-64 w-full" viewBox="0 0 500 350" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M250 50 L380 90 V180 C380 260 250 310 250 310 C250 310 120 260 120 180 V90 L250 50 Z" fill="#2E3440" stroke="#4C566A" strokeWidth="4" />
        <path d="M220 170 L245 195 L290 145" stroke="#A3BE8C" strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
];

export default function LoginPage() {
  usePageTitle('Sign in');
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [remember, setRemember] = useState(false);
  const [currentSlide, setCurrentSlide] = useState(0);
  const returnTo = params.get('returnTo');

  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  });

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentSlide((prev) => (prev + 1) % carouselSlides.length);
    }, 5000);
    return () => clearInterval(timer);
  }, []);

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
          <h1 className="mb-0 font-font-1 text-left text-2xl font-bold tracking-[0em] text-gray-800">
            Welcome Back
          </h1>
          <p className="text-sm text-gray-500 mb-9 ml-1 font-font-4 tracking-wider">Log in to Your HRMS Portal</p>

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

          <form onSubmit={onSubmit} noValidate className="space-y-4">
            {/* Email */}
            <div className="mt-8">
              <input
                type="email"
                placeholder="Enter email"
                autoComplete="username"
                autoFocus
                className="w-full rounded-[4px] border-2 border-gray-400 px-4 py-3 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-cyan-500/20"
                {...register('email')}
              />
              {errors.email && (
                <p className="mt-1.5 text-xs text-red-500">{errors.email.message}</p>
              )}
            </div>

            {/* Password */}
            <div>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  placeholder="Password"
                  autoComplete="current-password"
                  className="w-full rounded-[4px] border-2 border-gray-400 px-4 py-3 pr-11 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-cyan-500/20"
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
              {errors.password && (
                <p className="mt-1.5 text-xs text-red-500">{errors.password.message}</p>
              )}
            </div>

            {/* Remember me */}
            <div className="flex justify-between">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="remember"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-cyan-500 focus:ring-blue-500"
                />
                <label htmlFor="remember" className="text-sm text-gray-600">
                  Remember me
                </label>
              </div>
              <div>
                <a href="#" className="text-sm text-blue-500 hover:underline">
                  Forgot password
                </a>
              </div>
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

          <p className="mt-6 text-center text-sm text-gray-500">
            Don't have account yet?{' '}
            <a href="#" className="font-medium text-blue-500 hover:underline">
              Sign up
            </a>
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