/**
 * A router small enough to read in one sitting.
 *
 * Paths use :params. Handlers receive a context object rather than raw req/res,
 * so route code never touches the transport and stays directly testable.
 */

import { notFound } from "./errors.js";

export function createRouter() {
  const routes = [];

  const add = (method, pattern, handler) => {
    const names = [];
    const regex = new RegExp("^" + pattern.replace(/:([A-Za-z_]+)/g, (_, n) => {
      names.push(n);
      return "([^/]+)";
    }) + "$");
    routes.push({ method, regex, names, handler, pattern });
  };

  return {
    get: (p, h) => add("GET", p, h),
    post: (p, h) => add("POST", p, h),
    delete: (p, h) => add("DELETE", p, h),
    routes,

    match(method, pathname) {
      let pathMatched = false;
      for (const r of routes) {
        const m = r.regex.exec(pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method) continue;
        const params = {};
        r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
        return { handler: r.handler, params, pattern: r.pattern };
      }
      // Distinguish "wrong verb" from "no such route" — it saves an integrator
      // an hour of confusion.
      if (pathMatched) {
        const err = notFound("That method is not allowed on this path.");
        err.status = 405;
        err.type = "method-not-allowed";
        err.title = "Method not allowed";
        throw err;
      }
      return null;
    },
  };
}
