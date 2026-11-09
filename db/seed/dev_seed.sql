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
  v_year int := extract(year FROM now())::int;
  v_month int := extract(month FROM now())::int;
  v_jan1 date := make_date(extract(year FROM now())::int, 1, 1);
  lt_cl bigint; lt_sl bigint; lt_el bigint; lt_lop bigint; lt_co bigint; lt_ml bigint; lt_pl bigint; lt_bl bigint;
  lt2_al bigint;
  pol_perm bigint; pol_contract bigint; pol2 bigint;
  ent bigint; ent_el bigint;
  cal bigint;
  rule record;
  wf bigint; wf2 bigint; wfc bigint; wfc2 bigint;
  b bigint;
  m int;
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
  SELECT t1, r_emp, id FROM permissions WHERE code IN (
    'leave.dashboard.view_self', 'leave.request.create_self', 'leave.request.view_self',
    'leave.request.cancel_self', 'leave.balance.view_self', 'leave.calendar.view_self');
  INSERT INTO role_permissions (tenant_id, role_id, permission_id)
  SELECT t1, r_mgr, id FROM permissions WHERE code IN (
    'leave.dashboard.view_team', 'leave.request.view_team', 'leave.request.approve', 'leave.request.reject',
    'leave.request.return', 'leave.approval_history.view_team', 'workflow.delegate');
  INSERT INTO role_permissions (tenant_id, role_id, permission_id)
  SELECT t1, r_hr, id FROM permissions WHERE code IN (
    'leave.dashboard.view_all', 'leave.request.view_all', 'leave.request.manage', 'leave.calendar.view_all',
    'leave.reports.view', 'leave.configuration.view', 'leave.configuration.manage', 'leave.policy.assign',
    'leave.balance.adjust', 'leave.request.approve', 'leave.request.reject', 'leave.request.return',
    'leave.approval_history.view_team',
    'workflow.view', 'workflow.configure', 'workflow.delegate',
    'roles.view', 'roles.manage', 'roles.assign', 'employee.view', 'employee.create', 'employee.update',
    'organization.view', 'organization.settings.view', 'organization.chart.view');
  INSERT INTO role_permissions (tenant_id, role_id, permission_id)
  SELECT t1, r_admin, id FROM permissions;
  INSERT INTO role_permissions (tenant_id, role_id, permission_id)
  SELECT t2, r2_emp, id FROM permissions WHERE code IN (
    'leave.dashboard.view_self', 'leave.request.create_self', 'leave.request.view_self',
    'leave.request.cancel_self', 'leave.balance.view_self', 'leave.calendar.view_self');
  INSERT INTO role_permissions (tenant_id, role_id, permission_id)
  SELECT t2, r2_hr, id FROM permissions WHERE code IN (
    'leave.dashboard.view_all', 'leave.request.view_all', 'leave.calendar.view_all', 'leave.reports.view',
    'leave.request.approve', 'leave.request.reject', 'leave.request.return', 'leave.approval_history.view_team',
    'workflow.configure', 'roles.manage', 'roles.assign', 'roles.view');
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

  -- --------------------------------------------- Work schedule configuration --
  -- Migration 017 seeds the four default employee types for tenants that exist
  -- when it runs; these tenants are created afterwards, so they are seeded here
  -- the same way provisioning.ts does it for a real new tenant.
  INSERT INTO employee_types (tenant_id, name, base_category, description)
  SELECT t.id, v.name, v.base_category, v.description
    FROM (VALUES (t1), (t2)) AS t(id)
   CROSS JOIN (VALUES
     ('Full-Time', 'full_time', 'Permanent employee working full standard hours'),
     ('Part-Time', 'part_time', 'Employee working reduced standard hours'),
     ('Contract',  'contract',  'Fixed-term or contractual engagement'),
     ('Intern',    'intern',    'Trainee or internship engagement')
   ) AS v(name, base_category, description);

  -- Same rule the API enforces: employment_type always equals base_category.
  UPDATE employees e
     SET employee_type_id = et.id
    FROM employee_types et
   WHERE et.tenant_id = e.tenant_id AND et.base_category = e.employment_type;

  -- Tenant Admin already holds every permission (granted above from the whole
  -- catalog). HR Admin configures work schedules, like it configures leave.
  INSERT INTO role_permissions (tenant_id, role_id, permission_id)
  SELECT t1, r_hr, id FROM permissions WHERE module = 'work_schedule';
  INSERT INTO role_permissions (tenant_id, role_id, permission_id)
  SELECT t2, r2_hr, id FROM permissions WHERE module = 'work_schedule';

  -- Sample shifts, work types, a rotation and a weekly schedule for tenant 1.
  INSERT INTO work_shifts (tenant_id, name, grace_time_minutes, description) VALUES
    (t1, 'General Shift', 15, '09:00 to 18:00, Monday to Friday'),
    (t1, 'Morning Shift', 10, '06:00 to 14:00'),
    (t1, 'Night Shift',   10, '22:00 to 06:00, runs past midnight');
  INSERT INTO work_types (tenant_id, name, description) VALUES
    (t1, 'Work From Office', 'On premises'),
    (t1, 'Work From Home',   'Remote'),
    (t1, 'Hybrid',           'Split between office and home');

  INSERT INTO rotating_shift_patterns (tenant_id, name, rotation_interval, rotation_unit, description)
  VALUES (t1, 'Morning / Night Weekly', 1, 'weeks', 'Alternates every week') RETURNING id INTO b;
  INSERT INTO rotating_shift_pattern_items (tenant_id, pattern_id, shift_id, sequence_order)
  SELECT t1, b, s.id, s.ord FROM (
    SELECT id, 1 AS ord FROM work_shifts WHERE tenant_id = t1 AND name = 'Morning Shift'
    UNION ALL
    SELECT id, 2 FROM work_shifts WHERE tenant_id = t1 AND name = 'Night Shift') s;

  INSERT INTO rotating_work_type_patterns (tenant_id, name, rotation_interval, rotation_unit, description)
  VALUES (t1, 'Office / Home Weekly', 1, 'weeks', 'Alternates every week') RETURNING id INTO b;
  INSERT INTO rotating_work_type_pattern_items (tenant_id, pattern_id, work_type_id, sequence_order)
  SELECT t1, b, w.id, w.ord FROM (
    SELECT id, 1 AS ord FROM work_types WHERE tenant_id = t1 AND name = 'Work From Office'
    UNION ALL
    SELECT id, 2 FROM work_types WHERE tenant_id = t1 AND name = 'Work From Home') w;

  -- Mon-Fri 09:00-18:00 with a 480 minute minimum; Saturday and Sunday off.
  INSERT INTO work_shift_schedules (tenant_id, shift_id, name, default_minimum_working_minutes, description)
  SELECT t1, id, 'General Weekly Schedule', 480, 'Standard Monday to Friday week'
    FROM work_shifts WHERE tenant_id = t1 AND name = 'General Shift'
  RETURNING id INTO b;
  INSERT INTO work_shift_schedule_days
    (tenant_id, schedule_id, day_of_week, is_working_day, start_time, end_time, minimum_working_minutes)
  SELECT t1, b, d, d <= 5,
         CASE WHEN d <= 5 THEN TIME '09:00' END,
         CASE WHEN d <= 5 THEN TIME '18:00' END,
         CASE WHEN d <= 5 THEN 480 ELSE 0 END
    FROM generate_series(1, 7) AS d;

  -- ---------------------------------------------------- Leave configuration --
  -- Sample data for development. Real tenants configure all of this themselves.
  INSERT INTO leave_types (tenant_id, code, name, category, is_paid, allow_half_day, requires_attachment,
                           allow_backdated, max_backdated_days, max_consecutive_days, min_notice_days, include_non_working_days)
  VALUES (t1, 'CL', 'Casual Leave', 'casual', true, true, false, false, NULL, 5, 0, false) RETURNING id INTO lt_cl;
  INSERT INTO leave_types (tenant_id, code, name, category, is_paid, allow_half_day, requires_attachment,
                           allow_backdated, max_backdated_days, max_consecutive_days, min_notice_days, include_non_working_days)
  VALUES (t1, 'SL', 'Sick Leave', 'sick', true, true, false, true, 7, NULL, 0, false) RETURNING id INTO lt_sl;
  INSERT INTO leave_types (tenant_id, code, name, category, is_paid, allow_half_day, requires_attachment,
                           allow_backdated, max_backdated_days, max_consecutive_days, min_notice_days, include_non_working_days)
  VALUES (t1, 'EL', 'Earned Leave', 'earned', true, true, false, false, NULL, 15, 3, false) RETURNING id INTO lt_el;
  INSERT INTO leave_types (tenant_id, code, name, category, is_paid, allow_half_day, requires_attachment,
                           allow_backdated, max_backdated_days, max_consecutive_days, min_notice_days, include_non_working_days)
  VALUES (t1, 'LOP', 'Loss of Pay', 'loss_of_pay', false, true, false, false, NULL, NULL, 0, false) RETURNING id INTO lt_lop;
  INSERT INTO leave_types (tenant_id, code, name, category, is_paid, allow_half_day, requires_attachment,
                           allow_backdated, max_backdated_days, max_consecutive_days, min_notice_days, include_non_working_days)
  VALUES (t1, 'CO', 'Compensatory Off', 'comp_off', true, true, false, false, NULL, NULL, 0, false) RETURNING id INTO lt_co;
  INSERT INTO leave_types (tenant_id, code, name, category, is_paid, allow_half_day, requires_attachment,
                           allow_backdated, max_backdated_days, max_consecutive_days, min_notice_days, include_non_working_days)
  VALUES (t1, 'ML', 'Maternity Leave', 'maternity', true, false, true, false, NULL, 182, 14, true) RETURNING id INTO lt_ml;
  INSERT INTO leave_types (tenant_id, code, name, category, is_paid, allow_half_day, requires_attachment,
                           allow_backdated, max_backdated_days, max_consecutive_days, min_notice_days, include_non_working_days)
  VALUES (t1, 'PL', 'Paternity Leave', 'paternity', true, false, false, false, NULL, 5, 3, false) RETURNING id INTO lt_pl;
  INSERT INTO leave_types (tenant_id, code, name, category, is_paid, allow_half_day, requires_attachment,
                           allow_backdated, max_backdated_days, max_consecutive_days, min_notice_days, include_non_working_days)
  VALUES (t1, 'BL', 'Bereavement Leave', 'bereavement', true, false, false, true, 7, 3, 0, false) RETURNING id INTO lt_bl;

  INSERT INTO leave_policies (tenant_id, code, name, description, effective_from, status, is_default, created_by)
  VALUES (t1, 'PERMANENT', 'Permanent Employee Policy', 'Default policy for permanent staff', v_jan1, 'active', true, u_asha)
  RETURNING id INTO pol_perm;
  INSERT INTO leave_policies (tenant_id, code, name, description, effective_from, status, created_by)
  VALUES (t1, 'CONTRACT', 'Contract Employee Policy', 'Fixed-term contractors', v_jan1, 'active', u_asha)
  RETURNING id INTO pol_contract;

  INSERT INTO leave_policy_entitlements (tenant_id, policy_id, leave_type_id, annual_entitlement, allow_negative_balance,
                                         allow_carry_forward, allow_encashment)
  VALUES (t1, pol_perm, lt_el, 18, false, true, true) RETURNING id INTO ent_el;
  INSERT INTO leave_policy_entitlements (tenant_id, policy_id, leave_type_id, annual_entitlement, allow_negative_balance) VALUES
    (t1, pol_perm, lt_lop, 0, true),
    (t1, pol_perm, lt_co, 0, false),
    (t1, pol_perm, lt_ml, 182, false),
    (t1, pol_perm, lt_pl, 5, false),
    (t1, pol_perm, lt_bl, 3, false),
    (t1, pol_contract, lt_lop, 0, true);
  INSERT INTO leave_policy_entitlements (tenant_id, policy_id, leave_type_id, annual_entitlement)
  VALUES (t1, pol_perm, lt_cl, 12) RETURNING id INTO ent;
  INSERT INTO leave_accrual_rules (tenant_id, policy_entitlement_id, accrual_frequency, accrual_amount, effective_from, status)
  VALUES (t1, ent, 'annual', 12, v_jan1, 'active');
  INSERT INTO leave_policy_entitlements (tenant_id, policy_id, leave_type_id, annual_entitlement)
  VALUES (t1, pol_perm, lt_sl, 12) RETURNING id INTO ent;
  INSERT INTO leave_accrual_rules (tenant_id, policy_entitlement_id, accrual_frequency, accrual_amount, effective_from, status)
  VALUES (t1, ent, 'annual', 12, v_jan1, 'active');
  INSERT INTO leave_accrual_rules (tenant_id, policy_entitlement_id, accrual_frequency, accrual_amount, maximum_balance, effective_from, status)
  VALUES (t1, ent_el, 'monthly', 1.5, 45, v_jan1, 'active');
  INSERT INTO leave_carry_forward_rules (tenant_id, policy_entitlement_id, maximum_carry_forward, maximum_balance,
                                         expiry_enabled, expiry_after_months, encashment_allowed, effective_from, status)
  VALUES (t1, ent_el, 15, 45, true, 3, true, v_jan1, 'active');
  INSERT INTO leave_comp_off_rules (tenant_id, leave_type_id, minimum_work_hours, earned_days, eligible_work_day_type,
                                    expiry_enabled, expiry_after_days, maximum_balance, effective_from)
  VALUES (t1, lt_co, 8, 1, 'non_working', true, 60, 10, v_jan1);

  INSERT INTO leave_holiday_calendars (tenant_id, code, name, calendar_year, effective_from, status, is_default, created_by)
  VALUES (t1, 'INDIA', 'India Holidays', v_year, v_jan1, 'active', true, u_asha) RETURNING id INTO cal;
  INSERT INTO leave_holidays (tenant_id, calendar_id, name, holiday_date, holiday_type, is_optional) VALUES
    (t1, cal, 'New Year''s Day',   make_date(v_year, 1, 1),   'optional',     true),
    (t1, cal, 'Republic Day',      make_date(v_year, 1, 26),  'national',     false),
    (t1, cal, 'Independence Day',  make_date(v_year, 8, 15),  'national',     false),
    (t1, cal, 'Gandhi Jayanti',    make_date(v_year, 10, 2),  'national',     false),
    (t1, cal, 'Company Foundation Day', make_date(v_year, 11, 24), 'organization', false),
    (t1, cal, 'Christmas Day',     make_date(v_year, 12, 25), 'festival',     false);

  INSERT INTO leave_types (tenant_id, code, name, category) VALUES (t2, 'AL', 'Annual Leave', 'earned') RETURNING id INTO lt2_al;
  INSERT INTO leave_policies (tenant_id, code, name, effective_from, status, is_default, created_by)
  VALUES (t2, 'STANDARD', 'Standard Policy', v_jan1, 'active', true, u_meera) RETURNING id INTO pol2;
  INSERT INTO leave_policy_entitlements (tenant_id, policy_id, leave_type_id, annual_entitlement)
  VALUES (t2, pol2, lt2_al, 20) RETURNING id INTO ent;
  INSERT INTO leave_accrual_rules (tenant_id, policy_entitlement_id, accrual_frequency, accrual_amount, effective_from, status)
  VALUES (t2, ent, 'annual', 20, v_jan1, 'active');

  -- Credit this year so far, exactly as the accrual job would have done: the same
  -- posting rows and idempotency keys, so running the job afterwards adds nothing.
  FOR rule IN
    SELECT r.tenant_id, r.id, r.accrual_frequency, r.accrual_amount, en.leave_type_id
      FROM leave_accrual_rules r
      JOIN leave_policy_entitlements en ON en.tenant_id = r.tenant_id AND en.id = r.policy_entitlement_id
  LOOP
    FOR emp IN SELECT id FROM employees WHERE tenant_id = rule.tenant_id LOOP
      INSERT INTO leave_balances (tenant_id, employee_id, leave_type_id, leave_year)
      VALUES (rule.tenant_id, emp.id, rule.leave_type_id, v_year)
      RETURNING id INTO b;
      IF rule.accrual_frequency = 'annual' THEN
        INSERT INTO leave_accrual_postings (tenant_id, accrual_rule_id, employee_id, period_key, scheduled_days, credited_days)
        VALUES (rule.tenant_id, rule.id, emp.id, v_year::text, rule.accrual_amount, rule.accrual_amount);
        INSERT INTO leave_balance_transactions (tenant_id, balance_id, txn_type, days, effective_date, idempotency_key, note)
        VALUES (rule.tenant_id, b, 'ACCRUAL', rule.accrual_amount, v_jan1,
                format('accrual:%s:%s:%s', rule.id, emp.id, v_year), 'Annual allocation');
      ELSE
        FOR m IN 1..v_month LOOP
          INSERT INTO leave_accrual_postings (tenant_id, accrual_rule_id, employee_id, period_key, scheduled_days, credited_days)
          VALUES (rule.tenant_id, rule.id, emp.id, format('%s-%s', v_year, lpad(m::text, 2, '0')), rule.accrual_amount, rule.accrual_amount);
          INSERT INTO leave_balance_transactions (tenant_id, balance_id, txn_type, days, effective_date, idempotency_key, note)
          VALUES (rule.tenant_id, b, 'ACCRUAL', rule.accrual_amount, make_date(v_year, m, 1),
                  format('accrual:%s:%s:%s-%s', rule.id, emp.id, v_year, lpad(m::text, 2, '0')), 'Monthly accrual');
        END LOOP;
      END IF;
    END LOOP;
  END LOOP;

  -- Leave workflow v1 (tenant 1): Manager -> HR Admin
  INSERT INTO workflow_definitions (tenant_id, module, name, version, created_by)
    VALUES (t1, 'leave', 'Leave Approval', 1, u_asha) RETURNING id INTO wf;
  INSERT INTO workflow_steps (tenant_id, workflow_id, step_order, name, approver_type,
                              required_permission_code, on_no_approver, fallback_role_id, sla_hours)
    VALUES (t1, wf, 1, 'Manager Approval', 'reporting_manager', 'leave.request.approve', 'fallback_role', r_hr, 48);
  INSERT INTO workflow_steps (tenant_id, workflow_id, step_order, name, approver_type, approver_role_id,
                              required_permission_code, approval_mode, sla_hours)
    VALUES (t1, wf, 2, 'HR Approval', 'role', r_hr, 'leave.request.approve', 'any', 48);
  UPDATE workflow_definitions SET status = 'published', published_by = u_asha, published_at = now()
    WHERE tenant_id = t1 AND id = wf;

  -- Tenant 2: single HR step
  INSERT INTO workflow_definitions (tenant_id, module, name, version, created_by)
    VALUES (t2, 'leave', 'Leave Approval', 1, u_meera) RETURNING id INTO wf2;
  INSERT INTO workflow_steps (tenant_id, workflow_id, step_order, name, approver_type, approver_role_id,
                              required_permission_code)
    VALUES (t2, wf2, 1, 'HR Approval', 'role', r2_hr, 'leave.request.approve');
  UPDATE workflow_definitions SET status = 'published', published_by = u_meera, published_at = now()
    WHERE tenant_id = t2 AND id = wf2;

  -- Comp off claims: same chain as leave (tenant 1: Manager -> HR; tenant 2: HR)
  INSERT INTO workflow_definitions (tenant_id, module, name, version, created_by)
    VALUES (t1, 'comp_off', 'Comp Off Approval', 1, u_asha) RETURNING id INTO wfc;
  INSERT INTO workflow_steps (tenant_id, workflow_id, step_order, name, approver_type,
                              required_permission_code, on_no_approver, fallback_role_id, sla_hours)
    VALUES (t1, wfc, 1, 'Manager Approval', 'reporting_manager', 'leave.request.approve', 'fallback_role', r_hr, 48);
  INSERT INTO workflow_steps (tenant_id, workflow_id, step_order, name, approver_type, approver_role_id,
                              required_permission_code, approval_mode, sla_hours)
    VALUES (t1, wfc, 2, 'HR Approval', 'role', r_hr, 'leave.request.approve', 'any', 48);
  UPDATE workflow_definitions SET status = 'published', published_by = u_asha, published_at = now()
    WHERE tenant_id = t1 AND id = wfc;

  INSERT INTO workflow_definitions (tenant_id, module, name, version, created_by)
    VALUES (t2, 'comp_off', 'Comp Off Approval', 1, u_meera) RETURNING id INTO wfc2;
  INSERT INTO workflow_steps (tenant_id, workflow_id, step_order, name, approver_type, approver_role_id,
                              required_permission_code)
    VALUES (t2, wfc2, 1, 'HR Approval', 'role', r2_hr, 'leave.request.approve');
  UPDATE workflow_definitions SET status = 'published', published_by = u_meera, published_at = now()
    WHERE tenant_id = t2 AND id = wfc2;
END $$;
