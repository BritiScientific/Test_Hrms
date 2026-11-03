import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { ChevronLeft, ChevronRight, Search, UserPlus, Users } from 'lucide-react';
import { useAuth, useMe } from '@/app/providers/AuthProvider';
import { EmptyState, ErrorState, LoadingBlock, PageHeader } from '@/components/feedback/States';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Select } from '@/components/ui/Field';
import { usePageTitle } from '@/hooks/usePageTitle';
import { employeesApi } from '@/services/employees-api';
import { formatDate } from '@/utils/format';
import { QuickAddDialog } from './QuickAddDialog';
import { AccessBadge, ProfileBadge, empKeys, useDepartments } from './shared';

const PAGE = 25;

function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function EmployeesListPage() {
  usePageTitle('Employees');
  const me = useMe();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [access, setAccess] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [status, setStatus] = useState('current');
  const [offset, setOffset] = useState(0);
  const debounced = useDebounced(search);
  useEffect(() => setOffset(0), [debounced, access, departmentId, status]);
  const quickAdd = params.get('new') === '1';
  const setQuickAdd = (on: boolean) => setParams(on ? { new: '1' } : {}, { replace: true });

  const departments = useDepartments();
  const q = useQuery({
    queryKey: empKeys.list({ debounced, access, departmentId, status, offset }),
    queryFn: () => employeesApi.list({
      search: debounced || undefined, access: access || undefined, status,
      departmentId: departmentId ? Number(departmentId) : undefined, limit: PAGE, offset,
    }),
    placeholderData: keepPreviousData,
  });

  return (
    <div>
      <QuickAddDialog open={quickAdd} onClose={() => setQuickAdd(false)} />
      <PageHeader
        title="Employees"
        description="Add people in seconds — they complete their own details after activating."
        actions={can('employee.create') && <Button icon={<UserPlus className="size-4" />} onClick={() => setQuickAdd(true)}>Quick add</Button>}
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-line p-4 lg:flex-row lg:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
            <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9"
              placeholder="Search name, code, email or job title" aria-label="Search employees" />
          </div>
          <div className="grid grid-cols-1 gap-3 xs:grid-cols-3 lg:w-[32rem]">
            <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} aria-label="Filter by department">
              <option value="">All departments</option>
              {departments.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
            <Select value={access} onChange={(e) => setAccess(e.target.value)} aria-label="Filter by access">
              <option value="">Any access</option>
              <option value="active">Active</option>
              <option value="invited">Invited</option>
              <option value="invite_expired">Link expired</option>
              <option value="no_login">No login</option>
            </Select>
            <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by employment status">
              <option value="current">Current staff</option>
              <option value="exited">Exited</option>
              <option value="all">Everyone</option>
            </Select>
          </div>
        </div>

        {q.isPending && <div className="p-4"><LoadingBlock rows={8} /></div>}
        {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
        {q.data && q.data.items.length === 0 && (
          <EmptyState icon={<Users />} title={debounced || access || departmentId ? 'No employees match' : 'No employees yet'}
            description={debounced || access || departmentId ? 'Try clearing the filters.' : 'Use Quick add to add your first employee.'}
            action={can('employee.create') && !debounced && <Button size="sm" onClick={() => setQuickAdd(true)} icon={<UserPlus className="size-4" />}>Quick add</Button>} />
        )}

        {q.data && q.data.items.length > 0 && (
          <>
            <div className="relative hidden overflow-x-auto md:block">
              <table className="w-full min-w-[60rem] text-left text-sm">
                <caption className="sr-only">Employees</caption>
                <thead className="border-b border-line bg-slate-50/70 text-xs font-medium tracking-wide text-muted uppercase">
                  <tr>
                    <th scope="col" className="px-4 py-2.5">Employee</th>
                    <th scope="col" className="px-4 py-2.5">Department</th>
                    <th scope="col" className="px-4 py-2.5">Manager</th>
                    <th scope="col" className="px-4 py-2.5">Joined</th>
                    <th scope="col" className="px-4 py-2.5">Access</th>
                    <th scope="col" className="px-4 py-2.5">Profile</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {q.data.items.map((e) => (
                    <tr key={e.id} className="hover:bg-slate-50/60">
                      <td className="px-4 py-3">
                        <Link to={`/employees/${e.id}`} className="flex items-center gap-3">
                          <Avatar name={e.fullName} size="md" />
                          <span className="min-w-0">
                            <span className="block font-medium text-ink hover:text-primary">{e.fullName}</span>
                            <span className="block text-xs text-muted">{e.employeeCode}{e.jobTitle && ` · ${e.jobTitle}`}</span>
                          </span>
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-slate-700">{e.department?.name ?? <span className="text-muted">—</span>}</td>
                      <td className="px-4 py-3 text-slate-700">{e.manager?.name ?? <span className="text-muted">—</span>}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-muted">{formatDate(e.dateOfJoining, me.tenant.preferences)}</td>
                      <td className="px-4 py-3"><AccessBadge status={e.access.status} /></td>
                      <td className="px-4 py-3"><ProfileBadge profile={e.profile} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="divide-y divide-line md:hidden">
              {q.data.items.map((e) => (
                <li key={e.id}>
                  <Link to={`/employees/${e.id}`} className="flex items-start gap-3 p-4">
                    <Avatar name={e.fullName} size="md" />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-ink">{e.fullName}</span>
                      <span className="block truncate text-xs text-muted">{e.employeeCode}{e.jobTitle && ` · ${e.jobTitle}`}{e.department && ` · ${e.department.name}`}</span>
                      <span className="mt-2 flex flex-wrap gap-1.5"><AccessBadge status={e.access.status} /><ProfileBadge profile={e.profile} /></span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2 text-xs text-muted">
              <span className="tabular">{offset + 1}–{Math.min(offset + PAGE, q.data.total)} of {q.data.total}</span>
              <div className="flex gap-1">
                <Button variant="ghost" size="icon" aria-label="Previous page" disabled={offset === 0} onClick={() => setOffset((o) => Math.max(0, o - PAGE))}>
                  <ChevronLeft className="size-4" aria-hidden />
                </Button>
                <Button variant="ghost" size="icon" aria-label="Next page" disabled={offset + PAGE >= q.data.total} onClick={() => setOffset((o) => o + PAGE)}>
                  <ChevronRight className="size-4" aria-hidden />
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
