function redactSensitiveText(value) {
  return String(value)
    .replace(/\b(sb_secret_[A-Za-z0-9._-]+|service_role_[A-Za-z0-9._-]+)\b/gi, '[REDACTED]')
    .replace(/\b(authorization|api[ _-]?key|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\/\/[^\s/:@]+:[^\s/@]+@/g, '//[REDACTED]@')
}

function safeField(error, field) {
  const value = error && typeof error === 'object' ? error[field] : undefined
  return typeof value === 'string' || typeof value === 'number' ? redactSensitiveText(value) : undefined
}

/** Formats selected, non-credential Supabase/PostgREST fields without serializing arbitrary errors. */
export function formatErrorDiagnostics(error) {
  const message = safeField(error, 'message')
    ?? (error instanceof Error ? redactSensitiveText(error.message) : undefined)
    ?? (error && typeof error === 'object' ? 'Unstructured error object' : redactSensitiveText(error ?? 'Unknown error'))
  const fields = [['code', safeField(error, 'code')], ['details', safeField(error, 'details')], ['hint', safeField(error, 'hint')], ['status', safeField(error, 'status')]]
    .filter(([, value]) => value !== undefined)
    .map(([label, value]) => `${label}: ${value}`)
  return [message, ...fields].join('\n')
}

/** Adds the failed Data API operation and table while preserving safe API diagnostics. */
export class SupabaseOperationError extends Error {
  constructor({ operation, table, error }) {
    super(`Supabase Data API ${operation} on ${table} failed:\n${formatErrorDiagnostics(error)}`)
    this.name = 'SupabaseOperationError'
    this.operation = operation
    this.table = table
    this.code = safeField(error, 'code')
    this.details = safeField(error, 'details')
    this.hint = safeField(error, 'hint')
    this.status = safeField(error, 'status')
  }
}
