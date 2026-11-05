import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { SETTINGS_NAV, firstSettingsPath, visibleGroups } from '@/components/navigation/nav-config';
import {
  ancestorsOf, CARD_H, CARD_W, centreOn, defaultExpanded, findMatches, fitTransform, indexChart, isOffScreen,
  layoutForest, MAX_SCALE, MIN_SCALE, visibleCards, WINDOW_FROM, zoomAt,
} from '@/modules/organization/chart/chart-layout';
import OrganizationChartPage from '@/modules/organization/OrganizationChartPage';
import { orgKeys } from '@/modules/organization/hooks';
import { ApiError } from '@/services/api-client';
import { organizationApi } from '@/services/organization-api';
import type { OrganizationChart, OrgChartNode } from '@/types/api';

const auth = vi.hoisted(() => ({ perms: new Set<string>(['organization.chart.view', 'employee.view']), employeeId: null as number | null }));

vi.mock('@/app/providers/AuthProvider', async (orig) => {
  const actual = await orig<typeof import('@/app/providers/AuthProvider')>();
  return {
    ...actual,
    useAuth: () => ({
      can: (c: string) => auth.perms.has(c),
      canAny: (...c: string[]) => c.some((x) => auth.perms.has(x)),
    }),
    useMe: () => ({
      employeeId: auth.employeeId,
      tenant: { preferences: { dateFormat: 'DD/MM/YYYY', timezone: 'Asia/Kolkata' } },
    }),
  };
});

function person(id: number, fullName: string, children: OrgChartNode[] = [], extra: Partial<OrgChartNode> = {}): OrgChartNode {
  return {
    id, fullName, employeeCode: `E${id}`, jobTitle: `${fullName} title`,
    department: { id: 10, name: 'Engineering' }, status: 'active', employmentType: 'full_time',
    workLocation: 'Bengaluru', dateOfJoining: '2024-03-01', photoUrl: null, manager: null, upcomingManager: null,
    directReportCount: children.length, totalReportCount: children.reduce((n, c) => n + 1 + c.totalReportCount, 0),
    matched: true, issue: null, children,
    ...extra,
  };
}

function chartOf(roots: OrgChartNode[], unassigned: OrgChartNode[] = [], summary: Partial<OrganizationChart['summary']> = {}): OrganizationChart {
  const count = (ns: OrgChartNode[]): number => ns.reduce((n, c) => n + 1 + count(c.children), 0);
  return {
    asOf: '2026-11-04',
    summary: {
      employees: count(roots) + unassigned.length, roots: roots.length, unassigned: unassigned.length,
      issues: { cycle: 0, managerExited: 0, managerMissing: 0 },
      ...summary,
    },
    roots,
    unassigned,
    filterOptions: {
      departments: [{ id: 10, name: 'Engineering' }, { id: 20, name: 'Human Resources' }],
      managers: [{ id: 1, name: 'Vikram', jobTitle: 'Director', directReportCount: 2 }, { id: 2, name: 'Suresh', jobTitle: 'HR Manager', directReportCount: 1 }],
    },
  };
}

/** Vikram > (Anita, Suresh > Krishna > (Priya, Rahul)); Asha has no manager and no team. */
function seedChart() {
  const krishna = person(4, 'Krishna', [
    person(5, 'Priya', [], { manager: { id: 4, name: 'Krishna', jobTitle: null, status: 'active' } }),
    person(6, 'Rahul', [], { manager: { id: 4, name: 'Krishna', jobTitle: null, status: 'active' }, jobTitle: 'Software Engineer' }),
  ], { manager: { id: 2, name: 'Suresh', jobTitle: null, status: 'active' } });
  const suresh = person(2, 'Suresh', [krishna], { manager: { id: 1, name: 'Vikram', jobTitle: null, status: 'active' } });
  const anita = person(3, 'Anita', [], { manager: { id: 1, name: 'Vikram', jobTitle: null, status: 'active' } });
  return chartOf([person(1, 'Vikram', [anita, suresh])], [person(7, 'Asha')]);
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter><OrganizationChartPage /></MemoryRouter>
    </QueryClientProvider>,
  );
  return { client, ...view };
}

const cardFor = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}, .*Open details$`) });
const cardBox = (name: string) => cardFor(name).closest('[data-node-id]') as HTMLElement;
const queryCard = (name: string) => screen.queryByRole('button', { name: new RegExp(`^${name}, .*Open details$`) });

let chartApi: MockInstance<typeof organizationApi.chart>;

beforeEach(() => {
  auth.perms = new Set(['organization.chart.view', 'employee.view']);
  auth.employeeId = null;
  chartApi = vi.spyOn(organizationApi, 'chart').mockResolvedValue(seedChart());
});
afterEach(() => vi.restoreAllMocks());

describe('rendering', () => {
  it('shows the header, count and the hierarchy from the API', async () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Organization Chart' })).toBeInTheDocument();
    await screen.findByRole('button', { name: /^Vikram, / });
    expect(screen.getByText('7 employees')).toBeInTheDocument();
    for (const name of ['Vikram', 'Anita', 'Suresh', 'Krishna', 'Priya', 'Rahul']) expect(cardFor(name)).toBeInTheDocument();
  });

  it('cards show name, number, title, department, report count and initials', async () => {
    renderPage();
    await screen.findByRole('button', { name: /^Krishna, / });
    const card = within(cardFor('Krishna'));
    expect(card.getByText('Krishna')).toBeInTheDocument();
    expect(card.getByText('E4')).toBeInTheDocument();
    expect(card.getByText('Krishna title')).toBeInTheDocument();
    expect(card.getByText('Engineering')).toBeInTheDocument();
    expect(card.getByText('2 direct reports')).toBeInTheDocument();
    expect(card.getByText('K')).toBeInTheDocument();
  });

  it('uses the photo when there is one', async () => {
    chartApi.mockResolvedValue(chartOf([person(1, 'Vikram', [person(2, 'Anita', [], { photoUrl: '/photo.png' })])]));
    const { container } = renderPage();
    await screen.findByRole('button', { name: /^Anita, / });
    expect(container.querySelector('img[src="/photo.png"]')).toBeInTheDocument();
  });

  it('marks the top of the hierarchy and draws connector lines', async () => {
    renderPage();
    await screen.findByRole('button', { name: /^Vikram, / });
    expect(cardBox('Vikram')).toHaveAttribute('data-root');
    expect(cardBox('Anita')).not.toHaveAttribute('data-root');
    expect(screen.getByTestId('chart-connectors').getAttribute('d')).toMatch(/^M/);
  });

  it('lists people without a manager separately, not on the canvas', async () => {
    renderPage();
    await screen.findByText('No reporting manager (1)');
    const list = screen.getByRole('button', { name: /Asha/ });
    expect(list.closest('[data-node-id]')).toBeNull();
    expect(queryCard('Asha')).not.toBeInTheDocument();
  });

  it('shows reporting issues and context cards', async () => {
    chartApi.mockResolvedValue(chartOf(
      [person(1, 'Lead', [person(2, 'Member')], { issue: 'manager_exited', manager: { id: 9, name: 'Gone', jobTitle: null, status: 'exited' }, matched: false })],
      [],
      { employees: 1, issues: { cycle: 0, managerExited: 1, managerMissing: 0 } },
    ));
    renderPage();
    expect(await screen.findByText('Some reporting lines need attention')).toBeInTheDocument();
    expect(screen.getByText(/1 person reports to a manager who has left/)).toBeInTheDocument();
    expect(cardFor('Lead').className).toContain('border-dashed');
    expect(screen.getByText('1 employee')).toBeInTheDocument();
  });
});

describe('expand and collapse', () => {
  it('hides and shows a branch, and keeps the toggle state accessible', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: /^Priya, / });
    const toggle = screen.getByRole('button', { name: /Collapse Krishna’s team/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await user.click(toggle);
    expect(queryCard('Priya')).not.toBeInTheDocument();
    expect(queryCard('Krishna')).toBeInTheDocument();
    const reopen = screen.getByRole('button', { name: /Expand Krishna’s team/ });
    expect(reopen).toHaveAttribute('aria-expanded', 'false');

    await user.click(reopen);
    expect(cardFor('Priya')).toBeInTheDocument();
  });

  it('a card with no team has no toggle', async () => {
    renderPage();
    await screen.findByRole('button', { name: /^Anita, / });
    expect(screen.queryByRole('button', { name: /Anita’s team/ })).not.toBeInTheDocument();
  });

  it('expand all and collapse all', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: /^Priya, / });
    await user.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(queryCard('Anita')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(cardFor('Priya')).toBeInTheDocument();
  });

  it('opening a branch keeps the clicked card where it was on screen', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: /^Priya, / });
    await user.click(screen.getByRole('button', { name: /Collapse Krishna’s team/ }));
    const screenPosition = () => {
      const box = cardBox('Krishna');
      const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(screen.getByTestId('chart-content').style.transform)!;
      return [Number(box.style.left.replace('px', '')) * Number(m[3]) + Number(m[1]), Number(box.style.top.replace('px', '')) * Number(m[3]) + Number(m[2])];
    };
    const before = screenPosition();
    await user.click(screen.getByRole('button', { name: /Expand Krishna’s team/ }));
    expect(screenPosition()[0]).toBeCloseTo(before[0]);
    expect(screenPosition()[1]).toBeCloseTo(before[1]);
  });
});

describe('zoom and position', () => {
  const zoomLabel = () => screen.getByLabelText(/^Zoom \d+ percent$/);

  it('zoom in, zoom out, fit and reset change the view', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: /^Vikram, / });
    const content = screen.getByTestId('chart-content');
    const fitted = content.style.transform;

    await user.click(screen.getByRole('button', { name: 'Zoom out' }));
    const smaller = zoomLabel().textContent;
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(parseInt(zoomLabel().textContent!, 10)).toBeGreaterThan(parseInt(smaller!, 10));

    await user.click(screen.getByRole('button', { name: 'Fit to screen' }));
    expect(content.style.transform).toBe(fitted);

    await user.click(screen.getByRole('button', { name: 'Reset position' }));
    expect(zoomLabel()).toHaveTextContent('100%');
  });

  it('the direction buttons and arrow keys move the chart', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: /^Vikram, / });
    const content = screen.getByTestId('chart-content');
    const start = content.style.transform;
    await user.click(screen.getByRole('button', { name: 'Move left' }));
    expect(content.style.transform).not.toBe(start);

    const afterButton = content.style.transform;
    screen.getByTestId('chart-viewport').focus();
    await user.keyboard('{ArrowDown}');
    expect(content.style.transform).not.toBe(afterButton);
  });
});

describe('search and highlight', () => {
  it('highlights matches and reports the count, without another request', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: /^Priya, / });
    const calls = chartApi.mock.calls.length;
    await user.type(screen.getByLabelText('Search employees'), 'rahul');
    await waitFor(() => expect(cardBox('Rahul')).toHaveAttribute('data-highlight', 'active'));
    expect(screen.getByText('1 of 1 match')).toBeInTheDocument();
    expect(cardBox('Priya')).toHaveAttribute('data-highlight', 'none');
    expect(cardFor('Rahul')).toHaveAccessibleName(expect.stringContaining('search match'));
    expect(chartApi.mock.calls.length).toBe(calls);
  });

  it('searches by employee number and job title too', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: /^Priya, / });
    const box = screen.getByLabelText('Search employees');
    await user.type(box, 'E3');
    await waitFor(() => expect(cardBox('Anita')).toHaveAttribute('data-highlight', 'active'));
    await user.clear(box);
    await user.type(box, 'software eng');
    await waitFor(() => expect(cardBox('Rahul')).toHaveAttribute('data-highlight', 'active'));
  });

  it('opens collapsed branches to reach the current match', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: /^Priya, / });
    await user.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(queryCard('Rahul')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Search employees'), 'rahul');
    await waitFor(() => expect(cardBox('Rahul')).toHaveAttribute('data-highlight', 'active'));
  });

  it('steps through several matches', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: /^Priya, / });
    await user.type(screen.getByLabelText('Search employees'), 'title');
    await screen.findByText(/^1 of \d+ matches$/);
    const first = document.querySelector('[data-highlight="active"]')!.getAttribute('data-node-id');
    await user.click(screen.getByRole('button', { name: 'Next match' }));
    await screen.findByText(/^2 of \d+ matches$/);
    expect(document.querySelector('[data-highlight="active"]')!.getAttribute('data-node-id')).not.toBe(first);
    await user.click(screen.getByRole('button', { name: 'Previous match' }));
    await screen.findByText(/^1 of \d+ matches$/);
  });

  it('finds people in the no-manager list', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: /^Priya, / });
    await user.type(screen.getByLabelText('Search employees'), 'asha');
    await waitFor(() => expect(screen.getByRole('button', { name: /Asha/ })).toHaveAttribute('data-highlight', 'active'));
  });

  it('says when nothing matches', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: /^Priya, / });
    await user.type(screen.getByLabelText('Search employees'), 'nobody');
    expect(await screen.findByText('No matches')).toBeInTheDocument();
    expect(document.querySelector('[data-highlight="active"]')).toBeNull();
  });
});

describe('filters', () => {
  it('department filter asks the API and shows what it returns', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: /^Priya, / });
    chartApi.mockResolvedValue(chartOf([person(1, 'Vikram', [person(3, 'Anita')])], [], { employees: 1 }));
    await user.selectOptions(screen.getByLabelText('Filter by department'), '20');
    await waitFor(() => expect(chartApi).toHaveBeenLastCalledWith(expect.objectContaining({ departmentId: 20 })));
    await waitFor(() => expect(queryCard('Priya')).not.toBeInTheDocument());
    expect(cardFor('Anita')).toBeInTheDocument();
    expect(screen.getByText('1 employee')).toBeInTheDocument();
  });

  it('active-employee filter is sent to the API; exited stay out by default', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: /^Priya, / });
    expect(chartApi).toHaveBeenCalledWith(expect.objectContaining({ status: 'current' }));
    await user.selectOptions(screen.getByLabelText('Filter by employment status'), 'active');
    await waitFor(() => expect(chartApi).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'active' })));
  });

  it('reporting-manager filter is sent to the API', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: /^Priya, / });
    await user.click(screen.getByLabelText('Filter by reporting manager'));
    await user.click(screen.getByRole('option', { name: /Suresh/ }));
    await waitFor(() => expect(chartApi).toHaveBeenLastCalledWith(expect.objectContaining({ managerId: 2 })));
  });

  it('a filter with no result offers to clear it', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: /^Priya, / });
    chartApi.mockResolvedValue(chartOf([], []));
    await user.selectOptions(screen.getByLabelText('Filter by department'), '20');
    expect(await screen.findByText('No employees match')).toBeInTheDocument();
    chartApi.mockResolvedValue(seedChart());
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await screen.findByRole('button', { name: /^Priya, / });
  });
});

describe('employee details panel', () => {
  it('opens from a card with the employee’s details', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: /^Krishna, / });
    await user.click(cardFor('Krishna'));
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByRole('heading', { name: 'Krishna' })).toBeInTheDocument();
    expect(within(panel).getByText('Bengaluru')).toBeInTheDocument();
    expect(within(panel).getByText('01/03/2024')).toBeInTheDocument();
    expect(within(panel).getByText('Full-time')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Suresh' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: /Priya/ })).toBeInTheDocument();
  });

  it('moves between manager and reports', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: /^Krishna, / });
    await user.click(cardFor('Krishna'));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Suresh' }));
    expect(within(screen.getByRole('dialog')).getByRole('heading', { name: 'Suresh' })).toBeInTheDocument();
  });

  it('“View reporting hierarchy” applies the manager filter', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: /^Suresh, / });
    await user.click(cardFor('Suresh'));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'View reporting hierarchy' }));
    await waitFor(() => expect(chartApi).toHaveBeenLastCalledWith(expect.objectContaining({ managerId: 2 })));
  });

  it('links to the full record only for people allowed to open it', async () => {
    const user = userEvent.setup();
    auth.perms = new Set(['organization.chart.view']);
    renderPage();
    await screen.findByRole('button', { name: /^Krishna, / });
    await user.click(cardFor('Krishna'));
    const panel = await screen.findByRole('dialog');
    expect(within(panel).queryByRole('link', { name: 'Full profile' })).not.toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Close dialog' }));

    auth.perms = new Set(['organization.chart.view', 'employee.view']);
    await user.click(cardFor('Rahul'));
    expect(within(await screen.findByRole('dialog')).getByRole('link', { name: 'Full profile' })).toHaveAttribute('href', '/employees/6');
  });

  it('shows who a future joiner will report to, from the unassigned list', async () => {
    const user = userEvent.setup();
    chartApi.mockResolvedValue(chartOf([], [person(8, 'New Joiner', [], { upcomingManager: { id: 1, name: 'Vikram', effectiveFrom: '2026-12-01' } })]));
    renderPage();
    await screen.findByText(/Reports to Vikram from 01\/12\/2026/);
    await user.click(screen.getByRole('button', { name: /New Joiner/ }));
    expect(within(await screen.findByRole('dialog')).getByText(/No manager yet\. Vikram from 01\/12\/2026/)).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).queryByRole('button', { name: 'Show on chart' })).not.toBeInTheDocument();
  });
});

describe('page states', () => {
  it('shows a loading state', async () => {
    chartApi.mockReturnValue(new Promise(() => undefined));
    renderPage();
    expect(screen.getByRole('status', { name: 'Loading organization chart' })).toBeInTheDocument();
  });

  it('shows an API error with retry', async () => {
    const user = userEvent.setup();
    chartApi.mockRejectedValue(new ApiError(500, 'INTERNAL', 'Internal server error', undefined, 'req-1'));
    renderPage();
    expect(await screen.findByText('Internal server error')).toBeInTheDocument();
    chartApi.mockResolvedValue(seedChart());
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('button', { name: /^Vikram, / });
  });

  it('keeps the chart if a refresh fails', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: /^Vikram, / });
    chartApi.mockRejectedValue(new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server.'));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Couldn’t refresh the chart')).toBeInTheDocument();
    expect(cardFor('Vikram')).toBeInTheDocument();
  });

  it('an empty organization explains itself, with a next step for HR', async () => {
    auth.perms = new Set(['organization.chart.view', 'employee.create']);
    chartApi.mockResolvedValue(chartOf([]));
    renderPage();
    expect(await screen.findByText('No employees yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add employee' })).toHaveAttribute('href', '/employees?new=1');
    expect(screen.queryByTestId('chart-viewport')).not.toBeInTheDocument();
  });

  it('nobody has a manager yet: no canvas, just the list', async () => {
    chartApi.mockResolvedValue(chartOf([], [person(1, 'Solo')]));
    renderPage();
    expect(await screen.findByText('No reporting lines to draw')).toBeInTheDocument();
    expect(screen.queryByTestId('chart-viewport')).not.toBeInTheDocument();
    expect(screen.getByText('No reporting manager (1)')).toBeInTheDocument();
  });

  it('Refresh refetches', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: /^Vikram, / });
    const before = chartApi.mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(chartApi.mock.calls.length).toBe(before + 1));
  });
});

describe('responsive behaviour', () => {
  const setViewportWidth = (w: number) => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(w);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  };
  const scaleOf = () => Number(/scale\(([\d.]+)\)/.exec(screen.getByTestId('chart-content').style.transform)![1]);

  it('the canvas is its own viewport: touch gestures pan it and the page never scrolls sideways', async () => {
    renderPage();
    await screen.findByRole('button', { name: /^Vikram, / });
    const viewport = screen.getByTestId('chart-viewport');
    expect(viewport.className).toContain('touch-none');
    expect(viewport.className).toContain('overflow-clip');
  });

  it('a wide monitor fits the small hierarchy at full size', async () => {
    setViewportWidth(2560);
    renderPage();
    await screen.findByRole('button', { name: /^Vikram, / });
    expect(scaleOf()).toBeLessThanOrEqual(1);
    expect(scaleOf()).toBeGreaterThan(0.55);
  });

  it('a phone opens at a readable size on the top of the chart instead of shrinking everything', async () => {
    setViewportWidth(320);
    renderPage();
    await screen.findByRole('button', { name: /^Vikram, / });
    expect(scaleOf()).toBeCloseTo(0.85);
    const m = /translate\((-?[\d.]+)px/.exec(screen.getByTestId('chart-content').style.transform)!;
    const left = Number(cardBox('Vikram').style.left.replace('px', '')) * scaleOf() + Number(m[1]);
    expect(left + (CARD_W * scaleOf()) / 2).toBeCloseTo(160);
  });

  it('“fit” still shows everything on a phone when asked', async () => {
    const user = userEvent.setup();
    setViewportWidth(320);
    renderPage();
    await screen.findByRole('button', { name: /^Vikram, / });
    await user.click(screen.getByRole('button', { name: 'Fit to screen' }));
    expect(scaleOf()).toBeLessThan(0.55);
  });

  it('on narrow screens pan buttons are left to touch gestures', async () => {
    renderPage();
    await screen.findByRole('button', { name: /^Vikram, / });
    const pad = screen.getByRole('button', { name: 'Move up' }).parentElement!;
    expect(pad.className).toContain('hidden');
    expect(pad.className).toContain('md:grid');
  });
});

describe('navigation and cache', () => {
  it('appears under Organization only for people holding the permission', () => {
    const allowed = (...c: string[]) => c.includes('organization.chart.view');
    const org = visibleGroups(SETTINGS_NAV, allowed).find((g) => g.label === 'Organization')!;
    expect(org.items.map((i) => i.label)).toEqual(['Organization Chart']);
    expect(org.items[0].to).toBe('/settings/organization-chart');
    expect(firstSettingsPath(allowed)).toBe('/settings/organization-chart');

    const labels = visibleGroups(SETTINGS_NAV, () => false).flatMap((g) => g.items.map((i) => i.label));
    expect(labels).not.toContain('Organization Chart');
  });

  it('keeps Organization profile and settings ahead of it', () => {
    const org = SETTINGS_NAV.find((g) => g.label === 'Organization')!;
    expect(org.items.map((i) => i.label)).toEqual(['Organization profile', 'Organization settings', 'Organization Chart']);
  });

  it('an employee change invalidates the chart, so a new manager shows up', async () => {
    const { client } = renderPage();
    await screen.findByRole('button', { name: /^Vikram, / });
    expect(orgKeys.chart({})[0]).toBe('employees');
    const before = chartApi.mock.calls.length;
    await client.invalidateQueries({ queryKey: ['employees'] }); // what useInvalidateEmployees() does
    await waitFor(() => expect(chartApi.mock.calls.length).toBe(before + 1));
  });
});

describe('layout geometry', () => {
  const tree = person(1, 'A', [person(2, 'B', [person(4, 'D')]), person(3, 'C')]);
  const all = new Set([1, 2, 3, 4]);
  const overlaps = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    a.x < b.x + CARD_W && b.x < a.x + CARD_W && a.y < b.y + CARD_H && b.y < a.y + CARD_H;

  it('places children below their manager, with the manager centred, and no overlap', () => {
    const { cards } = layoutForest([tree], all);
    const at = (id: number) => cards.find((c) => c.node.id === id)!;
    expect(at(2).y).toBeGreaterThan(at(1).y + CARD_H);
    expect(at(1).x + CARD_W / 2).toBeCloseTo((at(2).x + at(3).x + CARD_W) / 2);
    for (const a of cards) for (const b of cards) if (a !== b) expect(overlaps(a, b)).toBe(false);
  });

  it('collapsed branches are not laid out at all', () => {
    expect(layoutForest([tree], new Set([1])).cards.map((c) => c.node.id)).toEqual([1, 2, 3]);
    expect(layoutForest([tree], new Set()).cards.map((c) => c.node.id)).toEqual([1]);
  });

  it('several roots sit side by side, each marked as a root', () => {
    const { cards, width } = layoutForest([person(1, 'A'), person(2, 'B')], new Set());
    expect(cards.every((c) => c.isRoot)).toBe(true);
    expect(cards[1].x).toBeGreaterThan(cards[0].x + CARD_W);
    expect(width).toBeGreaterThan(cards[1].x + CARD_W);
  });

  it('a manager with many childless reports uses a compact grid, not one long row', () => {
    const reports = Array.from({ length: 20 }, (_, i) => person(i + 2, `R${i}`));
    const { cards, width } = layoutForest([person(1, 'Boss', reports)], new Set([1]));
    expect(width).toBeLessThan(5 * (CARD_W + 28) + 100);
    for (const a of cards) for (const b of cards) if (a !== b) expect(overlaps(a, b)).toBe(false);
  });

  it('every report gets a connector end at the top of its card', () => {
    const { cards, connectors } = layoutForest([tree], all);
    for (const c of cards.filter((x) => !x.isRoot)) {
      expect(connectors).toContain(`M${c.x + CARD_W / 2} `);
      expect(connectors).toMatch(new RegExp(`V${c.y}(M|$)`));
    }
  });

  it('fit shows everything inside the viewport and never enlarges past 100%', () => {
    const layout = { width: 4000, height: 1000 };
    const t = fitTransform(layout, { w: 1000, h: 500 });
    expect(t.scale).toBeCloseTo(0.25);
    expect(t.x).toBeGreaterThanOrEqual(0);
    expect(t.y).toBeGreaterThanOrEqual(0);
    expect(fitTransform({ width: 100, height: 100 }, { w: 1000, h: 500 }).scale).toBe(1);
    expect(fitTransform({ width: 100_000, height: 100 }, { w: 320, h: 500 }).scale).toBe(MIN_SCALE);
  });

  it('zoom keeps the point under the cursor still and respects limits', () => {
    const t = zoomAt({ x: 10, y: 20, scale: 1 }, 2, 100, 100);
    expect((100 - t.x) / t.scale).toBeCloseTo(90);
    expect((100 - t.y) / t.scale).toBeCloseTo(80);
    expect(zoomAt({ x: 0, y: 0, scale: 1.9 }, 2, 0, 0).scale).toBe(MAX_SCALE);
    expect(zoomAt({ x: 0, y: 0, scale: 0.11 }, 0.1, 0, 0).scale).toBe(MIN_SCALE);
  });

  it('centres a card and can tell when one is off screen', () => {
    const view = { w: 800, h: 600 };
    const t = centreOn({ x: 1000, y: 500 }, 1, view);
    expect(t.x + 1000 + CARD_W / 2).toBeCloseTo(400);
    expect(isOffScreen({ x: 1000, y: 500 }, t, view)).toBe(false);
    expect(isOffScreen({ x: 5000, y: 500 }, t, view)).toBe(true);
  });
});

describe('large organizations', () => {
  const big = Array.from({ length: 2000 }, (_, i) => person(i + 2, `Person ${i}`));

  it('opens big charts collapsed to the first levels; small ones fully', () => {
    const large = chartOf([person(1, 'Boss', big.map((p, i) => (i % 40 === 0 ? { ...p, children: [person(9000 + i, `Leaf ${i}`)] } : p)))]);
    expect([...defaultExpanded(large, indexChart(large))]).toEqual([1]);
    const small = seedChart();
    expect([...defaultExpanded(small, indexChart(small))].sort()).toEqual([1, 2, 4]);
  });

  it('only mounts cards near the viewport', () => {
    const { cards } = layoutForest([person(1, 'Boss', big)], new Set([1]));
    expect(cards.length).toBeGreaterThan(WINDOW_FROM);
    const near = visibleCards(cards, { x: 0, y: 0, scale: 1 }, { w: 1280, h: 800 });
    expect(near.length).toBeGreaterThan(0);
    expect(near.length).toBeLessThan(60);
  });

  it('renders thousands of people without mounting them all', async () => {
    chartApi.mockResolvedValue(chartOf([person(1, 'Boss', big)]));
    const user = userEvent.setup();
    const { container } = renderPage();
    await screen.findByText('2001 employees');
    await user.click(screen.getByRole('button', { name: 'Reset position' }));
    const mounted = container.querySelectorAll('[data-node-id]').length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(200);
  });

  it('search reaches someone in a branch that is not on screen', () => {
    const data = seedChart();
    const index = indexChart(data);
    expect(findMatches(index, 'rahul')).toEqual([6]);
    expect(ancestorsOf(6, index)).toEqual([4, 2, 1]);
    expect(findMatches(index, '   ')).toEqual([]);
  });
});
