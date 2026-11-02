/** Server-derived identity for the current request. Never built from the request body. */
export interface AuthContext {
  tenantId: number;
  userId: number;
  employeeId: number | null;
  permissions: ReadonlySet<string>;
  requestId?: string;
}

export function hasPermission(auth: AuthContext, code: string): boolean {
  return auth.permissions.has(code);
}
