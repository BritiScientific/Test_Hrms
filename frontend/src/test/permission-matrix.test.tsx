import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PermissionMatrix } from '@/modules/permissions/PermissionMatrix';
import type { Permission } from '@/types/api';

const catalogue: Permission[] = [
  { code: 'roles.view', module: 'rbac', description: 'View roles and permissions' },
  { code: 'roles.manage', module: 'rbac', description: 'Create roles and change role permissions' },
  { code: 'payroll.view', module: 'payroll', description: 'View payroll' },
  { code: 'payroll.process', module: 'payroll', description: 'Process payroll' },
];

function Harness({ held, initial = [] as string[], onChange }: { held: string[]; initial?: string[]; onChange?: (s: Set<string>) => void }) {
  const [sel, setSel] = useState(new Set(initial));
  return (
    <PermissionMatrix
      catalogue={catalogue}
      selected={sel}
      original={new Set(initial)}
      grantable={(c) => held.includes(c)}
      onChange={(s) => {
        setSel(s);
        onChange?.(s);
      }}
    />
  );
}

describe('PermissionMatrix', () => {
  it('groups the API catalogue by module (nothing invented)', () => {
    render(<Harness held={[]} />);
    expect(screen.getByRole('heading', { name: 'Roles & access' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Payroll' })).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox')).toHaveLength(2 + 4); // 2 module toggles + 4 permissions
  });

  it('module select-all only adds permissions that are visible AND grantable', async () => {
    const onChange = vi.fn();
    render(<Harness held={['payroll.view', 'roles.view']} onChange={onChange} />);
    await userEvent.type(screen.getByLabelText('Search permissions'), 'payroll');
    expect(screen.queryByRole('heading', { name: 'Roles & access' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Select all visible Payroll permissions'));
    expect([...onChange.mock.calls.at(-1)![0]]).toEqual(['payroll.view']);
  });

  it('a permission the user does not hold cannot be granted, but an existing grant can be removed', async () => {
    const onChange = vi.fn();
    render(<Harness held={[]} initial={['payroll.process']} onChange={onChange} />);
    expect(screen.getByRole('checkbox', { name: /Process payroll/ })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: /View payroll/ })).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: /Process payroll/ }));
    expect([...onChange.mock.calls.at(-1)![0]]).toEqual([]);
    expect(screen.getByText('Removing')).toBeInTheDocument();
  });
});
