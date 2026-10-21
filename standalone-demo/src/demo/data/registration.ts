import { DemoError, find, now, num, rows, str, uid, type DemoState, type Row } from "./types";

// Local equivalent of final handle_new_user/_registration_staff_claim. No
// password, delivery token or provider action is persisted here.
export function registerDemoIdentity(s: DemoState, userId: string, email: string, meta: Row): void {
  if (rows(s, "demo_auth_users").some(u => str(u.email).toLowerCase() === email.toLowerCase())) throw new DemoError("user_already_exists", "Email already registered locally");
  const timestamp = now(), name = str(meta.full_name) || null, phone = str(meta.phone) || null;
  const code = str(meta.invite_code), base = { id: userId, created_at: timestamp, updated_at: timestamp, is_active: true };
  if (meta.user_type === "portal") {
    if (!phone?.trim()) throw new DemoError("23514", "phone is required for portal registration");
    let customerId: unknown, role: unknown = "project_manager", invitedBy: unknown = null;
    if (code) {
      const invite = rows(s, "customer_portal_invites").filter(r => str(r.code).toLowerCase() === code.toLowerCase() && r.is_active === true && Date.parse(str(r.expires_at)) > Date.parse(timestamp) && num(r.used_count) < num(r.max_uses)).sort((a,b)=>str(b.created_at).localeCompare(str(a.created_at)))[0];
      if (!invite) throw new DemoError("22023", "invalid_portal_invite");
      find(s, "customers", invite.customer_id);customerId = invite.customer_id;role = invite.portal_role;invitedBy = invite.created_by ?? null;invite.used_count = num(invite.used_count) + 1;
    } else {
      customerId = uid();rows(s, "customers").push({ ...base, id: customerId, name: str(meta.company_name) || name || email.split("@")[0], phone, email, city: str(meta.city) || null, approval_status: "pending", created_by: userId });
    }
    rows(s, "customer_portal_users").push({ ...base, user_id: userId, customer_id: customerId, contact_name: name || email.split("@")[0], phone, portal_role: role, invited_by: invitedBy });
  } else {
    const config = rows(s, "registration_settings").find(r => r.id === "main");
    if (!config?.mode) throw new DemoError("22023", "staff_registration_configuration_missing");
    if (config.mode === "closed") throw new DemoError("22023", "staff_registration_closed");
    const allowedRoles = ["it_manager", "employee", "warehouse_manager", "viewer"];
    if (!["open_with_approval", "gradual", "invite_only"].includes(str(config.mode)) || !allowedRoles.includes(str(config.default_requested_role))) throw new DemoError("22023", "staff_registration_configuration_invalid");
    const domains = Array.isArray(config.allowed_domains) ? config.allowed_domains : [];
    if (domains.length > 0 && !domains.some(d => str(d).trim().replace(/^@+/, "").toLowerCase() === email.split("@")[1].toLowerCase())) throw new DemoError("22023", "staff_registration_domain_not_allowed");
    const inviteCode = code.trim();
    if (config.mode === "invite_only" && !inviteCode) throw new DemoError("22023", "staff_registration_invite_required");
    if (config.mode === "gradual" && num(config.remaining_slots) <= 0) throw new DemoError("22023", "staff_registration_capacity_exhausted");
    let requestedRole = config.default_requested_role;
    if (inviteCode) {
      const invite = rows(s, "registration_invites").find(r => str(r.code).toLowerCase() === inviteCode.toLowerCase() && r.is_active === true && (r.expires_at == null || Date.parse(str(r.expires_at)) > Date.parse(timestamp)) && (r.max_uses == null || num(r.used_count) < num(r.max_uses)));
      if (!invite || !allowedRoles.includes(str(invite.default_role))) throw new DemoError("22023", "staff_registration_invite_invalid");
      requestedRole = invite.default_role;invite.used_count = num(invite.used_count) + 1;
      rows(s, "registration_invite_uses").push({ id: uid(), invite_id: invite.id, user_id: userId, email, created_at: timestamp });
    }
    if (config.mode === "gradual") config.remaining_slots = num(config.remaining_slots) - 1;
    const department = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str(meta.department_id)) ? meta.department_id : null;
    if (department) find(s, "departments", department);
    rows(s, "app_users").push({ ...base, email, full_name: name, phone, department_id: department, registration_note: str(meta.registration_note) || null, requested_role: requestedRole, role: "viewer", role_key: "viewer", employee_id: null, approval_status: "pending", rejection_reason: null });
  }
  rows(s, "demo_auth_users").push({ id: userId, email, created_at: timestamp, email_confirmed_at: null });
}
