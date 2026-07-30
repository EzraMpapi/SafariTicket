/**
 * Transport. Everything above this file is independent of node:http, which is
 * why the whole API surface can be tested without opening a socket.
 */

import { createServer as createHttpServer } from "node:http";

export function createServer(app, { logger, maxBodyBytes = 64 * 1024 } = {}) {
  const server = createHttpServer(async (req, res) => {
    let body = null;

    if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
      const chunks = [];
      let size = 0;
      let aborted = false;

      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBodyBytes) {
          // Stop reading rather than buffering an attacker's upload.
          aborted = true;
          res.writeHead(413, { "content-type": "application/problem+json" });
          res.end(JSON.stringify({
            type: "https://api.safaritiketi.co.tz/problems/payload-too-large",
            title: "Payload too large", status: 413,
            detail: `Request body exceeds ${maxBodyBytes} bytes.`,
          }));
          req.destroy();
          break;
        }
        chunks.push(chunk);
      }
      if (aborted) return;

      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length) {
        try {
          body = JSON.parse(raw);
        } catch {
          res.writeHead(400, { "content-type": "application/problem+json" });
          res.end(JSON.stringify({
            type: "https://api.safaritiketi.co.tz/problems/invalid-json",
            title: "Invalid JSON", status: 400, detail: "The request body is not valid JSON.",
          }));
          return;
        }
      }
    }

    const result = await app.handle({
      method: req.method, url: req.url, headers: req.headers, body,
    });

    const headers = { "content-type": "application/json", ...result.headers };
    if (result.body === undefined) {
      res.writeHead(result.status, { "x-request-id": headers["x-request-id"] });
      res.end();
      return;
    }
    res.writeHead(result.status, headers);
    res.end(JSON.stringify(result.body));
  });

  /**
   * Graceful shutdown: stop accepting, let in-flight requests finish, then exit.
   * Without this, a rolling deploy drops the requests that were mid-flight.
   */
  function shutdown(graceMs = 15000) {
    return new Promise((resolve) => {
      logger?.info("shutdown started", { graceMs });
      const timer = setTimeout(() => {
        logger?.warn("shutdown grace expired; forcing close");
        server.closeAllConnections?.();
        resolve();
      }, graceMs);
      timer.unref?.();

      server.close(() => {
        clearTimeout(timer);
        logger?.info("shutdown complete");
        resolve();
      });
    });
  }

  return { server, shutdown };
}
