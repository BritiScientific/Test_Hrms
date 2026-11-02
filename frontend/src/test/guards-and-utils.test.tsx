import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { RequirePermission } from '@/app/guards';
import { visibleGroups, SETTINGS_NAV, firstSettingsPath } from '@/components/navigation/nav-config';
import { ApiError } from '@/services/api-client';
import { formatDate } from '@/utils/format';
import { landingPath, safeReturnTo } from '@/utils/navigation';
import { groupByModule } from '@/utils/permissions';

vi.mock('@/app/providers/AuthProvider', async (orig) => {
  const actual = await orig<typeof import('@/app/providers/AuthProvider')>();
  const perms = new Set(['roles.view']);
  return { ...actual, useAuth: () => ({ canAny: (...c: string[]) => c.some((x) => perms.has(x)), can: (c: string) => perms.has(c) }) };
});

const wrap = (ui: React.ReactNode) => render(
  <QueryClientProvider client={new QueryClient()}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>,
);

describe('RequirePermission (UX gate; the API enforces)', () => {
  it('renders the screen when any required permission is held', () => {
    wrap(<RequirePermission anyOf={['roles.manage', 'roles.view']}><p>Roles screen</p></RequirePermission>);
    expect(screen.getByText('Roles screen')).toBeInTheDocument();
  });
  it('shows the access-denied state otherwise', () => {
    wrap(<RequirePermission anyOf={['organization.update']}><p>Secret</p></RequirePermission>);
    expect(screen.queryByText('Secret')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /don’t have access/ })).toBeInTheDocument();
  });
});

describe('navigation', () => {
  const canAny = (...c: string[]) => c.includes('roles.view');
  it('hides settings destinations the user cannot open', () => {
    const labels = visibleGroups(SETTINGS_NAV, canAny).flatMap((g) => g.items.map((i) => i.label));
    expect(labels).toContain('Role management');
    expect(labels).not.toContain('Organization profile');
    expect(labels).toContain('Security & audit'); // available to every member
  });
  it('/settings goes to the first permitted page', () => {
    expect(firstSettingsPath(canAny)).toBe('/settings/access/roles');
    expect(firstSettingsPath(() => false)).toBe('/settings/security');
  });
  it('rejects open redirects in returnTo', () => {
    expect(safeReturnTo('/settings/access/roles')).toBe('/settings/access/roles');
    expect(safeReturnTo('//evil.example')).toBe('/dashboard');
    expect(safeReturnTo('https://evil.example')).toBe('/dashboard');
    expect(safeReturnTo('/login')).toBe('/dashboard');
  });
  it('admins of an organization still onboarding land in the wizard', () => {
    expect(landingPath({ tenant: { onboardingCompleted: false }, permissions: ['organization.update'] })).toBe('/onboarding');
    expect(landingPath({ tenant: { onboardingCompleted: false }, permissions: [] }, '/settings/security')).toBe('/settings/security');
  });
});

describe('formatting & helpers', () => {
  it('formats dates with the organization preference, without timezone day shifts', () => {
    expect(formatDate('2026-11-05', { dateFormat: 'DD/MM/YYYY', timezone: 'Asia/Kolkata' })).toBe('05/11/2026');
    expect(formatDate('2026-11-05', { dateFormat: 'MM/DD/YYYY', timezone: 'UTC' })).toBe('11/05/2026');
    expect(formatDate('2026-11-04T20:00:00Z', { dateFormat: 'YYYY-MM-DD', timezone: 'Asia/Kolkata' })).toBe('2026-11-05');
    expect(formatDate('2026-11-05', { dateFormat: 'DD MMM YYYY', timezone: 'UTC' })).toBe('05 Nov 2026');
  });
  it('orders permission groups by module', () => {
    const g = groupByModule([
      { code: 'leave.create', module: 'leave', description: '' },
      { code: 'organization.view', module: 'organization', description: '' },
    ]);
    expect(g.map((x) => x.label)).toEqual(['Organization', 'Leave']);
  });
  it('exposes server field errors from ApiError', () => {
    const e = new ApiError(422, 'VALIDATION_FAILED', 'Invalid', { fieldErrors: { 'address.postalCode': 'Bad', website: ['Must be URL'] } });
    expect(e.fieldErrors).toEqual({ 'address.postalCode': 'Bad', website: 'Must be URL' });
  });
});
