/**
 * @mindlog/adapter-http — HTTP adapter (PLAN 15.3, 17; layer `interfaces`):
 * health, metrics, REST API, the RESP console over WebSocket and the dashboard.
 */
export type { HttpServerDeps, HttpServerOptions } from './http-deps.js';
export { HttpServer } from './http-server.js';
export { CONSOLE_PROTOCOL } from './routes/console-routes.js';
export type { Problem } from './problem.js';
export { PROBLEM_CONTENT_TYPE, toProblem } from './problem.js';
