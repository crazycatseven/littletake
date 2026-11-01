let active: { code: string; lease: string; page: string } | null = null;
export function projectRequestContext(value: typeof active) { active = value; }
export function projectDiagnosticId(id: string): string { return active ? active.code + ':' + id : id; }
export function projectFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (active) { headers.set('x-littletake-project', active.code); headers.set('x-littletake-edit-lease', active.lease); headers.set('x-littletake-edit-page', active.page); }
  return fetch(input, { ...init, headers });
}
