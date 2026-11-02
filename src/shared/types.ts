/** Server-derived identity for the current request. Never built from the request body. */
export interface AuthContext {
  tenantId: number;
  userId: number;
  employeeId: number | null;
  permissions: ReadonlySet<string>;
  requestId?: string;
  /** auth_sessions.id of the HTTP session (absent when services are called directly, e.g. tests). */
  sessionId?: string;
  sessionExpiresAt?: string;
}

export function hasPermission(auth: AuthContext, code: string): boolean {
  return auth.permissions.has(code);
}

export function hasAnyPermission(auth: AuthContext, ...codes: string[]): boolean {
  return codes.some((c) => auth.permissions.has(c));
}
