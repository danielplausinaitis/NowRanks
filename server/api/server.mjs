import http from 'node:http'

/** Adapts the pure API handler to Node's built-in HTTP server. */
export function createApiServer({ handler, requestTimeoutMs = 30_000 }) {
  return http.createServer(async (request, response) => {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      if (!response.headersSent) {
        response.writeHead(504, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        response.end(JSON.stringify({ error: { code: 'timeout', message: 'Request timed out' } }))
      }
    }, requestTimeoutMs)
    try {
      const result = await handler({ method: request.method, url: request.url })
      if (!timedOut) {
        response.writeHead(result.status, result.headers)
        response.end(result.body)
      }
    } catch {
      if (!timedOut) {
        response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        response.end(JSON.stringify({ error: { code: 'internal_error', message: 'Unable to process request' } }))
      }
    } finally {
      clearTimeout(timer)
    }
  })
}
