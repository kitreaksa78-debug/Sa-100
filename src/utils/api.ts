/**
 * Backend API URL helper.
 *
 * All API routes are handled by the Express server under `/api/<name>`.
 */
export function apiUrl(name: string): string {
  return `/api/${name}`;
}
