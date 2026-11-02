import { useState } from 'react';
import { useNavigate } from 'react-router';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/Toast';
import { ApiError } from '@/services/api-client';
import { rbacApi } from '@/services/rbac-api';
import type { RoleSummary } from '@/types/api';
import { RoleFormDialog } from './RoleFormDialog';
import { useInvalidateRbac } from './hooks';

type RoleLike = Pick<RoleSummary, 'id' | 'name' | 'description' | 'is_active' | 'member_count'>;
type Pending = { kind: 'edit' | 'duplicate' | 'deactivate' | 'activate'; role: RoleLike } | null;

/** Shared edit / duplicate / (de)activate flows for the role list and role detail screens. */
export function useRoleActions() {
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const invalidate = useInvalidateRbac();
  const { notify } = useToast();
  const navigate = useNavigate();
  const close = () => setPending(null);

  const toggleActive = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      if (pending.kind === 'deactivate') await rbacApi.deactivateRole(pending.role.id);
      else await rbacApi.activateRole(pending.role.id);
      await invalidate();
      notify({ tone: 'success', title: pending.kind === 'deactivate' ? `“${pending.role.name}” deactivated` : `“${pending.role.name}” re-activated` });
      close();
    } catch (e) {
      notify({ tone: 'error', title: 'Could not change the role', description: e instanceof ApiError ? e.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  const dialogs = (
    <>
      <RoleFormDialog
        open={pending?.kind === 'edit'}
        onClose={close}
        title="Edit role"
        initial={{ name: pending?.role.name ?? '', description: pending?.role.description ?? '' }}
        submitLabel="Save changes"
        onSubmit={async (v) => {
          await rbacApi.updateRole(pending!.role.id, v);
          await invalidate();
          notify({ tone: 'success', title: 'Role updated' });
          close();
        }}
      />
      <RoleFormDialog
        open={pending?.kind === 'duplicate'}
        onClose={close}
        title={`Duplicate “${pending?.role.name ?? ''}”`}
        description="Creates a new custom role with the same permissions. Nobody is assigned to it yet."
        initial={{ name: pending ? `${pending.role.name} (copy)` : '', description: pending?.role.description ?? '' }}
        submitLabel="Create copy"
        onSubmit={async (v) => {
          const created = await rbacApi.cloneRole(pending!.role.id, v);
          await invalidate();
          notify({ tone: 'success', title: `Role “${created.name}” created` });
          close();
          navigate(`/settings/access/roles/${created.id}`);
        }}
      />
      <ConfirmDialog
        open={pending?.kind === 'deactivate'}
        onClose={close}
        onConfirm={toggleActive}
        loading={busy}
        tone="destructive"
        title={`Deactivate “${pending?.role.name ?? ''}”?`}
        confirmLabel="Deactivate role"
      >
        <p className="text-sm text-slate-700">
          {pending?.role.member_count
            ? <>The <strong>{pending.role.member_count}</strong> member{pending.role.member_count === 1 ? '' : 's'} holding this role lose its permissions on their next request.</>
            : 'Nobody currently holds this role.'}{' '}
          Assignments and audit history are kept, and you can re-activate the role later.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={pending?.kind === 'activate'}
        onClose={close}
        onConfirm={toggleActive}
        loading={busy}
        title={`Re-activate “${pending?.role.name ?? ''}”?`}
        confirmLabel="Re-activate"
        description="Existing assignments of this role become effective again immediately."
      />
    </>
  );

  return {
    dialogs,
    edit: (role: RoleLike) => setPending({ kind: 'edit', role }),
    duplicate: (role: RoleLike) => setPending({ kind: 'duplicate', role }),
    deactivate: (role: RoleLike) => setPending({ kind: 'deactivate', role }),
    activate: (role: RoleLike) => setPending({ kind: 'activate', role }),
  };
}
