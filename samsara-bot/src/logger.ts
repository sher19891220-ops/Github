/** Structured single-line JSON logging, which is what Vercel's log drain wants. */

type Level = 'debug' | 'info' | 'warn' | 'error';

const REDACTED = '[redacted]';
const SECRET_KEY = /token|secret|password|authorization|apikey|api_key/i;

/** Strips obvious credentials so tokens never reach the log drain. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]';
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? REDACTED : redact(val, depth + 1);
    }
    return out;
  }
  return value;
}

function emit(level: Level, message: string, context?: Record<string, unknown>): void {
  const line = JSON.stringify({
    level,
    message,
    ...(context ? { context: redact(context) as Record<string, unknown> } : {}),
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (message: string, context?: Record<string, unknown>) => emit('debug', message, context),
  info: (message: string, context?: Record<string, unknown>) => emit('info', message, context),
  warn: (message: string, context?: Record<string, unknown>) => emit('warn', message, context),
  error: (message: string, context?: Record<string, unknown>) => emit('error', message, context),
};
