import { useQueryClient } from '@tanstack/react-query';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, Circle, LogOut, PartyPopper } from 'lucide-react';
import { useAuth, useMe } from '@/app/providers/AuthProvider';
import { ErrorState, InlineAlert, LoadingBlock } from '@/components/feedback/States';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { useToast } from '@/components/ui/Toast';
import { usePageTitle } from '@/hooks/usePageTitle';
import { ApiError } from '@/services/api-client';
import { organizationApi } from '@/services/organization-api';
import { cn } from '@/utils/cn';
import { LogoUploader } from '../organization/components/LogoUploader';
import { PreferencesForm } from '../organization/components/PreferencesForm';
import { ProfileForm } from '../organization/components/ProfileForm';
import { orgKeys, useOnboardingStatus, useOrgProfile, useOrgSettings } from '../organization/hooks';

const STEPS = [
  { key: 'details', label: 'Organization', description: 'Names and contact details' },
  { key: 'address', label: 'Address', description: 'Where you are registered' },
  { key: 'preferences', label: 'Preferences', description: 'Timezone, currency, financial year' },
  { key: 'branding', label: 'Branding', description: 'Logo (optional)' },
  { key: 'review', label: 'Finish', description: 'Review and complete' },
] as const;
type StepKey = (typeof STEPS)[number]['key'];

/**
 * First-run setup for a newly activated organization administrator. Each step
 * saves immediately, so the admin can leave and continue later; the
 * dashboard keeps showing setup progress until onboarding is completed.
 */
export default function OnboardingPage() {
  usePageTitle('Set up your organization');
  const { can, logout } = useAuth();
  const me = useMe();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const step = (STEPS.find((s) => s.key === params.get('step'))?.key ?? 'details') as StepKey;
  const index = STEPS.findIndex((s) => s.key === step);
  const go = (k: StepKey) => setParams({ step: k });
  const next = () => go(STEPS[Math.min(index + 1, STEPS.length - 1)].key);
  const back = () => go(STEPS[Math.max(index - 1, 0)].key);

  const profile = useOrgProfile();
  const settings = useOrgSettings();
  const status = useOnboardingStatus();

  if (!can('organization.update')) return <Navigate to="/dashboard" replace />;

  const signOut = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  const backButton = index > 0
    ? <Button variant="ghost" onClick={back} icon={<ArrowLeft className="size-4" />}>Back</Button>
    : null;

  return (
    <div className="min-h-dvh bg-canvas">
      <header className="sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
          <Avatar name={me.tenant.displayName} src={me.tenant.logoUrl} square size="md" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{me.tenant.displayName}</p>
            <p className="text-xs text-muted">Organization setup</p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => navigate('/dashboard')}>
            <span className="hidden sm:inline">Skip for now</span><span className="sm:hidden">Skip</span>
          </Button>
          <Button variant="ghost" size="icon" onClick={signOut} aria-label="Sign out"><LogOut className="size-4" aria-hidden /></Button>
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:py-10">
        {/* Stepper: horizontal on phones, vertical on desktop */}
        <nav aria-label="Setup steps">
          <ol className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:gap-1 lg:overflow-visible">
            {STEPS.map((s, i) => {
              const done = stepDone(s.key, status.data);
              const current = s.key === step;
              return (
                <li key={s.key} className="shrink-0">
                  <button
                    type="button"
                    onClick={() => go(s.key)}
                    aria-current={current ? 'step' : undefined}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                      current ? 'bg-surface shadow-card ring-1 ring-line' : 'hover:bg-slate-100',
                    )}
                  >
                    <span className={cn(
                      'flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                      done ? 'bg-success text-white' : current ? 'bg-primary text-white' : 'bg-slate-200 text-slate-600',
                    )}>
                      {done ? <Check className="size-3.5" aria-hidden /> : i + 1}
                    </span>
                    <span className="min-w-0">
                      <span className={cn('block whitespace-nowrap font-medium', current ? 'text-ink' : 'text-slate-600')}>{s.label}</span>
                      <span className="hidden text-xs text-muted lg:block">{s.description}</span>
                    </span>
                    {done && <span className="sr-only">(done)</span>}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <section aria-labelledby="step-title" className="min-w-0">
          <h1 id="step-title" className="page-title">{STEPS[index].label === 'Finish' ? 'Review and finish' : STEPS[index].description}</h1>
          <p className="mb-5 mt-1 text-sm text-muted">Step {index + 1} of {STEPS.length}. Everything can be changed later in Settings.</p>

          {(profile.isPending || settings.isPending) && <Card><CardBody><LoadingBlock rows={6} /></CardBody></Card>}
          {profile.isError && <Card><ErrorState error={profile.error} onRetry={() => profile.refetch()} /></Card>}

          {profile.data && step === 'details' && (
            <ProfileForm profile={profile.data} sections={['basic', 'contact']} guardUnsaved={false}
              submitLabel="Save and continue" onSaved={next} />
          )}
          {profile.data && step === 'address' && (
            <ProfileForm profile={profile.data} sections={['address']} guardUnsaved={false}
              submitLabel="Save and continue" onSaved={next} secondaryAction={backButton} />
          )}
          {settings.data && step === 'preferences' && (
            <PreferencesForm settings={settings.data} guardUnsaved={false} submitLabel="Save and continue"
              onSaved={next} secondaryAction={backButton} />
          )}
          {profile.data && step === 'branding' && (
            <Card>
              <CardHeader title="Logo" description="Shown in the portal header and sidebar. You can skip this." />
              <CardBody>
                <LogoUploader profile={profile.data} />
                <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  {backButton}
                  <Button onClick={next} icon={<ArrowRight className="size-4" />}>Continue</Button>
                </div>
              </CardBody>
            </Card>
          )}
          {step === 'review' && <ReviewStep onEdit={go} backButton={backButton} />}
        </section>
      </div>
    </div>
  );
}

function stepDone(key: StepKey, s: { steps: { key: string; done: boolean }[]; completed: boolean } | undefined) {
  if (!s) return false;
  const done = (k: string) => s.steps.find((x) => x.key === k)?.done ?? false;
  switch (key) {
    case 'details': return done('profile') && done('contact');
    case 'address': return done('address');
    case 'preferences': return done('preferences');
    case 'branding': return done('branding');
    case 'review': return s.completed;
  }
}

const STEP_FOR: Record<string, StepKey> = { profile: 'details', contact: 'details', address: 'address', preferences: 'preferences', branding: 'branding' };

function ReviewStep({ onEdit, backButton }: { onEdit: (k: StepKey) => void; backButton: React.ReactNode }) {
  const status = useOnboardingStatus();
  const qc = useQueryClient();
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const { notify } = useToast();

  const complete = async () => {
    try {
      await organizationApi.completeOnboarding();
      await qc.invalidateQueries({ queryKey: orgKeys.onboarding });
      await refresh();
      notify({ tone: 'success', title: 'Your organization is ready' });
      navigate('/dashboard', { replace: true });
    } catch (e) {
      notify({ tone: 'error', title: 'Could not finish setup', description: e instanceof ApiError ? e.message : undefined });
    }
  };

  if (status.isPending) return <Card><CardBody><LoadingBlock /></CardBody></Card>;
  if (status.isError) return <Card><ErrorState error={status.error} onRetry={() => status.refetch()} /></Card>;
  const s = status.data;

  return (
    <Card>
      <CardHeader
        title="Setup checklist"
        description={`${s.progress.done} of ${s.progress.total} done`}
        actions={s.completed ? <Badge tone="success">Completed</Badge> : undefined}
      />
      <ul className="divide-y divide-line">
        {s.steps.map((st) => (
          <li key={st.key} className="flex items-center gap-3 px-4 py-3 sm:px-5">
            {st.done
              ? <CheckCircle2 className="size-5 shrink-0 text-success" aria-label="Done" />
              : <Circle className="size-5 shrink-0 text-slate-300" aria-label="Not done" />}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{st.label} {st.optional && <span className="font-normal text-muted">(optional)</span>}</p>
              <p className="text-xs text-muted">{st.description}</p>
            </div>
            {!st.done && <Button variant="outline" size="sm" onClick={() => onEdit(STEP_FOR[st.key])}>Complete</Button>}
          </li>
        ))}
      </ul>
      <CardBody className="border-t border-line">
        {!s.canComplete && (
          <div className="mb-4"><InlineAlert tone="warning">Finish the required items above to complete setup. Optional items can be done later.</InlineAlert></div>
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {backButton}
          {s.completed
            ? <Button onClick={() => navigate('/dashboard')} icon={<ArrowRight className="size-4" />}>Go to dashboard</Button>
            : <Button onClick={complete} disabled={!s.canComplete} icon={<PartyPopper className="size-4" />}>Complete setup</Button>}
        </div>
      </CardBody>
    </Card>
  );
}
