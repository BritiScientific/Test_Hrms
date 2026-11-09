-- =============================================================================
-- 022 — Work Schedule Configuration: permission catalog
--   * Granular codes, one view/manage pair per resource, so a tenant can let
--     someone maintain shifts without also handing them employee types.
--     Activate and deactivate fall under manage.
--   * Granted to Tenant Admin ("full access") and to roles that already hold
--     leave.configuration.manage — the HR configuration role in practice.
--     No role name other than the protected system role is hard-coded.
--   * Managers and employees receive nothing: the employee form's dropdown is
--     served by a lookup route behind employee.create / employee.update.
--   * New tenants pick these up automatically, because provisioning.ts grants
--     every active permission to the Tenant Admin role it creates.
-- =============================================================================

INSERT INTO permissions (code, module, description) VALUES
  ('workschedule.employee_type.view',        'work_schedule', 'View employee types'),
  ('workschedule.employee_type.manage',      'work_schedule', 'Create, edit, activate and deactivate employee types'),
  ('workschedule.shift.view',                'work_schedule', 'View shifts'),
  ('workschedule.shift.manage',              'work_schedule', 'Create, edit, activate and deactivate shifts'),
  ('workschedule.work_type.view',            'work_schedule', 'View work types'),
  ('workschedule.work_type.manage',          'work_schedule', 'Create, edit, activate and deactivate work types'),
  ('workschedule.rotating_shift.view',       'work_schedule', 'View rotating shifts'),
  ('workschedule.rotating_shift.manage',     'work_schedule', 'Create, edit, activate and deactivate rotating shifts'),
  ('workschedule.rotating_work_type.view',   'work_schedule', 'View rotating work types'),
  ('workschedule.rotating_work_type.manage', 'work_schedule', 'Create, edit, activate and deactivate rotating work types'),
  ('workschedule.shift_schedule.view',       'work_schedule', 'View shift schedules'),
  ('workschedule.shift_schedule.manage',     'work_schedule', 'Create, edit, activate and deactivate shift schedules')
ON CONFLICT (code) DO NOTHING;

-- Tenant Admin keeps "full access"; existing HR configuration roles get the
-- same reach over work schedules that they already have over leave settings.
INSERT INTO role_permissions (tenant_id, role_id, permission_id)
SELECT r.tenant_id, r.id, p.id
  FROM roles r
 CROSS JOIN permissions p
 WHERE p.module = 'work_schedule'
   AND ((r.is_system_role AND r.name = 'Tenant Admin')
        OR EXISTS (
             SELECT 1 FROM role_permissions rp
               JOIN permissions lp ON lp.id = rp.permission_id
              WHERE rp.tenant_id = r.tenant_id AND rp.role_id = r.id
                AND lp.code = 'leave.configuration.manage'))
ON CONFLICT DO NOTHING;
