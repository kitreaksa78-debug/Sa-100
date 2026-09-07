/**
 * Backend API URL helper.
 *
 * - Dev / preview: the Express dev server (tsx server.ts) handles `/api/<name>`.
 * - Production static deploy: the platform mounts the Flask app as a serverless
 *   function at `/api/index.py`, so we call `/api/index.py?route=<name>` and the
 *   Flask dispatcher routes on the `route` query param.
 *
 * `import.meta.env.PROD` is statically replaced by Vite: false in dev, true in
 * the production build.
 */
export function apiUrl(name: string): string {
  return import.meta.env.PROD ? `/api/index.py?route=${name}` : `/api/${name}`;
}