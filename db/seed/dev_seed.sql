-- =============================================================================
-- Development seed: two tenants, the Rahul -> Krishna -> Suresh scenario.
-- Run as hrms_owner (BYPASSRLS). Passwords for all users: "Passw0rd!"
-- (scrypt hash format produced by src/modules/auth/password.ts).
-- =============================================================================
DO $$
DECLARE
  pw text := 'scrypt$16384$8$1$c2VlZC1zYWx0LTAwMDE=$scbHsLcGwRAwx6Pm20/B/MHjgrE0c6BHij7xJmE+9imCvJqP+fuK+CO5kAwD53GdWZqN1kmKuNP27M3myseshQ==';
  t1 bigint; t2 bigint;
  u_vikram bigint; u_suresh bigint; u_anita bigint; u_krishna bigint;
  u_rahul bigint; u_priya bigint; u_asha bigint; u_meera bigint; u_arjun bigint;
  u_kiran bigint;
  e_vikram bigint; e_suresh bigint; e_anita bigint; e_krishna bigint;
  e_rahul bigint; e_priya bigint; e_asha bigint; e_meera bigint; e_arjun bigint;
  r_emp bigint; r_mgr bigint; r_hr bigint; r_admin bigint;
  r2_emp bigint; r2_hr bigint; r2_admin bigint;
  d_eng bigint; d_hr bigint;
  lt_annual bigint; lt_sick bigint; lt2_annual bigint;
  wf bigint; wf2 bigint;
  b bigint;
  emp record;
BEGIN
  -- ABC has completed onboarding; XYZ has not (its admin, Meera, lands in the wizard).
  INSERT INTO tenants (name, slug, timezone, legal_name, industry, website, contact_email,
                       contact_phone, contact_person, address_line1, city, state_province,
                       postal_code, country_code, onboarding_completed_at)
  VALUES ('ABC Technologies', 'abc-technologies', 'Asia/Kolkata', 'ABC Technologies Private Limited',
          'Information Technology', 'https://abc.example', 'hello@abc.example', '+91 80 4000 1000',
          'Asha', '12 MG Road', 'Bengaluru', 'Karnataka', '560001', 'IN', now())
  RETURNING id INTO t1;
  INSERT INTO tenants (name, slug, timezone) VALUES ('XYZ Solutions', 'xyz-solutions', 'Asia/Kolkata')
  RETURNING id INTO t2;
  INSERT INTO tenant_settings (tenant_id, confirmed_at) VALUES (t1, now());
  INSERT INTO tenant_settings (tenant_id) VALUES (t2);

  INSERT INTO users (email, full_name, password_hash) VALUES ('vikram@abc.test',  'Vikram',  pw) RETURNING id INTO u_vikram;
  INSERT INTO users (email, full_name, password_hash) VALUES ('suresh@abc.test',  'Suresh',  pw) RETURNING id INTO u_suresh;
  INSERT INTO users (email, full_name, password_hash) VALUES ('anita@abc.test',   'Anita',   pw) RETURNING id INTO u_anita;
  INSERT INTO users (email, full_name, password_hash) VALUES ('krishna@abc.test', 'Krishna', pw) RETURNING id INTO u_krishna;
  INSERT INTO users (email, full_name, password_hash) VALUES ('rahul@abc.test',   'Rahul',   pw) RETURNING id INTO u_rahul;
  INSERT INTO users (email, full_name, password_hash) VALUES ('priya@abc.test',   'Priya',   pw) RETURNING id INTO u_priya;
  INSERT INTO users (email, full_name, password_hash) VALUES ('asha@abc.test',    'Asha',    pw) RETURNING id INTO u_asha;
  INSERT INTO users (email, full_name, password_hash) VALUES ('meera@xyz.test',   'Meera',   pw) RETURNING id INTO u_meera;
  INSERT INTO users (email, full_name, password_hash) VALUES ('arjun@xyz.test',   'Arjun',   pw) RETURNING id INTO u_arjun;
  -- Consultant who belongs to BOTH tenants: exercises organization selection.
  INSERT INTO users (email, full_name, password_hash) VALUES ('kiran@partners.test', 'Kiran', pw) RETURNING id INTO u_kiran;

  INSERT INTO tenant_users (tenant_id, user_id)
  SELECT t1, x FROM unnest(ARRAY[u_vikram, u_suresh, u_anita, u_krishna, u_rahul, u_priya, u_asha]) x;
  INSERT INTO tenant_users (tenant_id, user_id)
  SELECT t2, x FROM unnest(ARRAY[u_meera, u_arjun]) x;
  INSERT INTO tenant_users (tenant_id, user_id) VALUES (t1, u_kiran), (t2, u_kiran);

  INSERT INTO departments (tenant_id, name) VALUES (t1, 'Engineering') RETURNING id INTO d_eng;
  INSERT INTO departments (tenant_id, name) VALUES (t1, 'Human Resources') RETURNING id INTO d_hr;

  INSERT INTO employees (tenant_id, user_id, employee_code, full_name, department_id, date_of_joining)
    VALUES (t1, u_vikram,  'E001', 'Vikram',  d_eng, '2018-01-01') RETURNING id INTO e_vikram;
  INSERT INTO employees (tenant_id, user_id, employee_code, full_name, department_id, date_of_joining)
    VALUES (t1, u_suresh,  'E101', 'Suresh',  d_hr,  '2019-01-01') RETURNING id INTO e_suresh;
  INSERT INTO employees (tenant_id, user_id, employee_code, full_name, department_id, date_of_joining)
    VALUES (t1, u_anita,   'E102', 'Anita',   d_hr,  '2020-01-01') RETURNING id INTO e_anita;
  INSERT INTO employees (tenant_id, user_id, employee_code, full_name, department_id, date_of_joining)
    VALUES (t1, u_krishna, 'E201', 'Krishna', d_eng, '2020-06-01') RETURNING id INTO e_krishna;
  INSERT INTO employees (tenant_id, user_id, employee_code, full_name, department_id, date_of_joining)
    VALUES (t1, u_rahul,   'E501', 'Rahul',   d_eng, '2023-03-01') RETURNING id INTO e_rahul;
  INSERT INTO employees (tenant_id, user_id, employee_code, full_name, department_id, date_of_joining)
    VALUES (t1, u_priya,   'E502', 'Priya',   d_eng, '2023-04-01') RETURNING id INTO e_priya;
  INSERT INTO employees (tenant_id, user_id, employee_code, full_name, department_id, date_of_joining)
    VALUES (t1, u_asha,    'E900', 'Asha',    d_hr,  '2018-01-01') RETURNING id INTO e_asha;
  INSERT INTO employees (tenant_id, user_id, employee_code, full_name, date_of_joining)
    VALUES (t2, u_meera,   'E501', 'Meera',   '2021-01-01') RETURNING id INTO e_meera;   -- same code, other tenant: fine
  INSERT INTO employees (tenant_id, user_id, employee_code, full_name, date_of_joining)
    VALUES (t2, u_arjun,   'E502', 'Arjun',   '2022-01-01') RETURNING id INTO e_arjun;

  UPDATE employees SET job_title = v.title FROM (VALUES
      (e_vikram, 'Director of Engineering'), (e_suresh, 'HR Manager'), (e_anita, 'HR Executive'),
      (e_krishna, 'Engineering Manager'), (e_rahul, 'Software Engineer'), (e_priya, 'Software Engineer'),
      (e_asha, 'Chief People Officer')) AS v(id, title)
   WHERE employees.tenant_id = t1 AND employees.id = v.id;

  UPDATE departments SET head_employee_id = e_vikram WHERE tenant_id = t1 AND id = d_eng;
  UPDATE departments SET head_employee_id = e_suresh WHERE tenant_id = t1 AND id = d_hr;

  -- Reporting: Rahul, Priya -> Krishna -> Suresh -> Vikram; Anita -> Vikram
  INSERT INTO employee_reporting (tenant_id, employee_id, manager_id, effective_from) VALUES
    (t1, e_rahul,   e_krishna, '2024-01-01'),
    (t1, e_priya,   e_krishna, '2024-01-01'),
    (t1, e_krishna, e_suresh,  '2024-01-01'),
    (t1, e_suresh,  e_vikram,  '2024-01-01'),
    (t1, e_anita,   e_vikram,  '2024-01-01');
  INSERT INTO employee_reporting (tenant_id, employee_id, manager_id, effective_from) VALUES
    (t2, e_arjun, e_meera, '2024-01-01');

  -- Roles
  INSERT INTO roles (tenant_id, name, description) VALUES (t1, 'Employee', 'All staff') RETURNING id INTO r_emp;
  INSERT INTO roles (tenant_id, name, description) VALUES (t1, 'Manager', 'People managers') RETURNING id INTO r_mgr;
  INSERT INTO roles (tenant_id, name, description) VALUES (t1, 'HR Admin', 'HR operations') RETURNING id INTO r_hr;
  INSERT INTO roles (tenant_id, name, description, is_system_role)
    VALUES (t1, 'Tenant Admin', 'Full access', true) RETURNING id INTO r_admin;
  INSERT INTO roles (tenant_id, name) VALUES (t2, 'Employee') RETURNING id INTO r2_emp;
  INSERT INTO roles (tenant_id, name) VALUES (t2, 'HR Admin') RETURNING id INTO r2_hr;
  INSERT INTO roles (tenant_id, name, description, is_system_role)
    VALUES (t2, 'Tenant Admin', 'Full access', true) RETURNING id INTO r2_admin;

  INSERT INTO role_permissions (tenant_id, role_id, permission_id)
  SELECT t1, r_emp, id FROM permissions WHERE code IN ('leave.create', 'leave.view.own', 'leave.withdraw');
  INSERT INTO role_permissions (tenant_id, role_id, permission_id)
  SELECT t1, r_mgr, id FROM permissions WHERE code IN ('leave.view.team', 'leave.approve', 'workflow.delegate');
  INSERT INTO role_permissions (tenant_id, role_id, permission_id)
  SELECT t1, r_hr, id FROM permissions WHERE code IN (
    'leave.view.all', 'leave.approve', 'leave.balance.manage', 'leave.type.manage',
    'workflow.view', 'workflow.configure', 'workflow.delegate',
    'roles.view', 'roles.manage', 'roles.assign', 'employee.view', 'employee.create', 'employee.update',
    'organization.view', 'organization.settings.view', 'organization.chart.view');
  INSERT INTO role_permissions (tenant_id, role_id, permission_id)
  SELECT t1, r_admin, id FROM permissions;
  INSERT INTO role_permissions (tenant_id, role_id, permission_id)
  SELECT t2, r2_emp, id FROM permissions WHERE code IN ('leave.create', 'leave.view.own', 'leave.withdraw');
  INSERT INTO role_permissions (tenant_id, role_id, permission_id)
  SELECT t2, r2_hr, id FROM permissions WHERE code IN ('leave.view.all', 'leave.approve', 'workflow.configure', 'roles.manage', 'roles.assign', 'roles.view');
  INSERT INTO role_permissions (tenant_id, role_id, permission_id)
  SELECT t2, r2_admin, id FROM permissions;

  INSERT INTO user_roles (tenant_id, user_id, role_id, effective_from)
  SELECT t1, x, r_emp, '2024-01-01'
  FROM unnest(ARRAY[u_vikram, u_suresh, u_anita, u_krishna, u_rahul, u_priya, u_asha]) x;
  INSERT INTO user_roles (tenant_id, user_id, role_id, effective_from) VALUES
    (t1, u_krishna, r_mgr, '2024-01-01'),
    (t1, u_vikram,  r_mgr, '2024-01-01'),
    (t1, u_suresh,  r_mgr, '2024-01-01'),
    (t1, u_suresh,  r_hr,  '2024-01-01'),
    (t1, u_anita,   r_hr,  '2024-01-01'),
    (t1, u_asha,    r_admin, '2024-01-01');
  INSERT INTO user_roles (tenant_id, user_id, role_id, effective_from) VALUES
    (t2, u_meera, r2_hr,  '2024-01-01'),
    (t2, u_meera, r2_emp, '2024-01-01'),
    (t2, u_arjun, r2_emp, '2024-01-01'),
    (t2, u_meera, r2_admin, '2024-01-01'),
    (t2, u_kiran, r2_emp, '2024-01-01');
  INSERT INTO user_roles (tenant_id, user_id, role_id, effective_from) VALUES
    (t1, u_kiran, r_emp, '2024-01-01');

  -- Leave types, holiday, balances
  INSERT INTO leave_types (tenant_id, code, name) VALUES (t1, 'annual', 'Annual Leave') RETURNING id INTO lt_annual;
  INSERT INTO leave_types (tenant_id, code, name) VALUES (t1, 'sick', 'Sick Leave') RETURNING id INTO lt_sick;
  INSERT INTO leave_types (tenant_id, code, name) VALUES (t2, 'annual', 'Annual Leave') RETURNING id INTO lt2_annual;
  INSERT INTO holidays (tenant_id, holiday_date, name) VALUES (t1, '2026-11-24', 'Company Holiday');

  FOR emp IN SELECT tenant_id, id FROM employees LOOP
    INSERT INTO leave_balances (tenant_id, employee_id, leave_type_id, period_year)
    VALUES (emp.tenant_id, emp.id,
            CASE WHEN emp.tenant_id = t1 THEN lt_annual ELSE lt2_annual END, 2026)
    RETURNING id INTO b;
    INSERT INTO leave_balance_transactions (tenant_id, balance_id, txn_type, allocated_delta, note)
    VALUES (emp.tenant_id, b, 'allocation', 20, 'Annual allocation 2026');
  END LOOP;

  -- Leave workflow v1 (tenant 1): Manager -> HR Admin
  INSERT INTO workflow_definitions (tenant_id, module, name, version, created_by)
    VALUES (t1, 'leave', 'Leave Approval', 1, u_asha) RETURNING id INTO wf;
  INSERT INTO workflow_steps (tenant_id, workflow_id, step_order, name, approver_type,
                              required_permission_code, on_no_approver, fallback_role_id, sla_hours)
    VALUES (t1, wf, 1, 'Manager Approval', 'reporting_manager', 'leave.approve', 'fallback_role', r_hr, 48);
  INSERT INTO workflow_steps (tenant_id, workflow_id, step_order, name, approver_type, approver_role_id,
                              required_permission_code, approval_mode, sla_hours)
    VALUES (t1, wf, 2, 'HR Approval', 'role', r_hr, 'leave.approve', 'any', 48);
  UPDATE workflow_definitions SET status = 'published', published_by = u_asha, published_at = now()
    WHERE tenant_id = t1 AND id = wf;

  -- Tenant 2: single HR step
  INSERT INTO workflow_definitions (tenant_id, module, name, version, created_by)
    VALUES (t2, 'leave', 'Leave Approval', 1, u_meera) RETURNING id INTO wf2;
  INSERT INTO workflow_steps (tenant_id, workflow_id, step_order, name, approver_type, approver_role_id,
                              required_permission_code)
    VALUES (t2, wf2, 1, 'HR Approval', 'role', r2_hr, 'leave.approve');
  UPDATE workflow_definitions SET status = 'published', published_by = u_meera, published_at = now()
    WHERE tenant_id = t2 AND id = wf2;
END $$;
