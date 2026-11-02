import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { RotateCcw, Save } from 'lucide-react';
import { useAuth } from '@/app/providers/AuthProvider';
import { ErrorState, InlineAlert, LoadingBlock, PageHeader } from '@/components/feedback/States';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/Toast';
import { usePageTitle } from '@/hooks/usePageTitle';
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges';
import { ApiError } from '@/services/api-client';
import { rbacApi } from '@/services/rbac-api';
import { PermissionMatrix } from '../permissions/PermissionMatrix';
import { useInvalidateRbac, usePermissionCatalogue, useRole } from './hooks';

/** Role → permission editor. Changes are staged locally and saved atomically (one PUT, one audit entry). */
export default function RolePermissionsPage() {
  const id = Number(useParams().roleId);
  const { can, me } = useAuth();
  const role = useRole(id);
  const catalogue = usePermissionCatalogue();
  const invalidate = useInvalidateRbac();
  const { notify } = useToast();
  usePageTitle(role.data ? `${role.data.name} · permissions` : 'Permissions');

  const original = useMemo(() => new Set(role.data?.permissions.map((p) => p.code) ?? []), [role.data]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setSelected(new Set(original)), [original]);

  const added = [...selected].filter((c) => !original.has(c)).sort();
  const removed = [...original].filter((c) => !selected.has(c)).sort();
  const dirty = added.length + removed.length > 0;
  const blocker = useUnsavedChanges(dirty && !saving);

  const held = useMemo(() => new Set(me?.permissions ?? []), [me]);
  const readOnly = !can('roles.manage') || !!role.data?.is_system_role || !role.data?.is_active;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await rbacApi.setRolePermissions(id, [...selected]);
      await invalidate();
      notify({ tone: 'success', title: 'Permissions saved', description: `${added.length} added, ${removed.length} removed` });
      setConfirm(false);
    } catch (e) {
      setConfirm(false);
      setError(e instanceof ApiError
        ? e.code === 'LOCKOUT' ? 'This change would leave nobody able to manage roles, so it was not saved.' : e.message
        : 'Could not save permissions.');
    } finally {
      setSaving(false);
    }
  };

  if (role.isPending || catalogue.isPending) return <Card><CardBody><LoadingBlock rows={10} /></CardBody></Card>;
  if (role.isError) return <Card><ErrorState error={role.error} onRetry={() => role.refetch()} /></Card>;
  if (catalogue.isError) return <Card><ErrorState error={catalogue.error} onRetry={() => catalogue.refetch()} /></Card>;
  const label = (code: string) => catalogue.data.find((p) => p.code === code)?.description ?? code;

  return (
    <div className="pb-24">
      {blocker}
      <PageHeader
        eyebrow={<><Link to="/settings/access/roles" className="hover:text-ink">Roles</Link> / <Link to={`/settings/access/roles/${id}`} className="hover:text-ink">{role.data.name}</Link></>}
        title={`Permissions for “${role.data.name}”`}
        description="Choose what members of this role can do. Only permissions defined by the platform are listed."
      />
      <div className="mb-4 space-y-3">
        {role.data.is_system_role && <InlineAlert tone="info">System roles are protected; this view is read-only.</InlineAlert>}
        {!role.data.is_active && <InlineAlert tone="warning">This role is inactive. Re-activate it before changing permissions.</InlineAlert>}
        {!readOnly && (
          <InlineAlert tone="info">You can only grant permissions you hold yourself (marked with a lock otherwise). Removing is always allowed.</InlineAlert>
        )}
        {error && <InlineAlert>{error}</InlineAlert>}
      </div>

      <PermissionMatrix
        catalogue={catalogue.data}
        selected={selected}
        original={original}
        onChange={setSelected}
        grantable={(c) => held.has(c)}
        readOnly={readOnly}
      />

      {!readOnly && dirty && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 shadow-pop backdrop-blur lg:left-[var(--sidebar-width)]">
          <div className="safe-bottom mx-auto flex max-w-workspace flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:px-6 lg:px-8">
            <p className="flex-1 text-sm" aria-live="polite">
              <span className="font-medium">Unsaved changes:</span>{' '}
              <Badge tone="success">+{added.length}</Badge> <Badge tone="danger">−{removed.length}</Badge>
            </p>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1 sm:flex-none" icon={<RotateCcw className="size-4" />} onClick={() => setSelected(new Set(original))}>Discard</Button>
              <Button className="flex-1 sm:flex-none" icon={<Save className="size-4" />} onClick={() => setConfirm(true)}>Review & save</Button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={save}
        loading={saving}
        title="Replace this role’s permissions?"
        description={`${role.data.member_count} member${role.data.member_count === 1 ? '' : 's'} will be affected on their next request.`}
        confirmLabel="Save permissions"
      >
        <div className="space-y-3 text-sm">
          {added.length > 0 && (
            <div>
              <p className="mb-1 font-medium text-green-700">Adding ({added.length})</p>
              <ul className="list-inside list-disc text-slate-700">{added.map((c) => <li key={c}>{label(c)}</li>)}</ul>
            </div>
          )}
          {removed.length > 0 && (
            <div>
              <p className="mb-1 font-medium text-red-700">Removing ({removed.length})</p>
              <ul className="list-inside list-disc text-slate-700">{removed.map((c) => <li key={c}>{label(c)}</li>)}</ul>
            </div>
          )}
        </div>
      </ConfirmDialog>
    </div>
  );
}
