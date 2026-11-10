-- =============================================================================
-- 024 — Rotation assignment permissions
--   * One view/manage pair per assignment kind, granted like 022: Tenant Admin
--     plus roles that already hold leave.configuration.manage.
--   * Managers and employees receive nothing.
--   * New tenants pick these up from provisioning (every active permission is
--     granted to the Tenant Admin role it creates).
-- =============================================================================

INSERT INTO permissions (code, module, description) VALUES
  ('workschedule.rotating_shift_assignment.view',        'work_schedule', 'View rotating shift assignments'),
  ('workschedule.rotating_shift_assignment.manage',      'work_schedule', 'Assign, change, end and cancel rotating shifts for employees'),
  ('workschedule.rotating_work_type_assignment.view',    'work_schedule', 'View rotating work type assignments'),
  ('workschedule.rotating_work_type_assignment.manage',  'work_schedule', 'Assign, change, end and cancel rotating work types for employees')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (tenant_id, role_id, permission_id)
SELECT r.tenant_id, r.id, p.id
  FROM roles r
 CROSS JOIN permissions p
 WHERE p.code LIKE 'workschedule.rotating\_%\_assignment.%'
   AND ((r.is_system_role AND r.name = 'Tenant Admin')
        OR EXISTS (
             SELECT 1 FROM role_permissions rp
               JOIN permissions lp ON lp.id = rp.permission_id
              WHERE rp.tenant_id = r.tenant_id AND rp.role_id = r.id
                AND lp.code = 'leave.configuration.manage'))
ON CONFLICT DO NOTHING;
