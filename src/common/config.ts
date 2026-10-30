/**
 * Small helpers for reading configuration from the environment.
 * Required values throw at startup so a misconfigured deployment fails fast
 * instead of silently falling back to insecure defaults.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Environment variable ${name} is required but not set.`);
  }
  return value.trim();
}

export function optionalEnv(name: string, fallback = ''): string {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

/** True when the value is missing or still looks like a template placeholder. */
export function isPlaceholder(value: string | undefined): boolean {
  if (!value) return true;
  const lower = value.toLowerCase();
  return lower.includes('your_') || lower.includes('placeholder') || lower.includes('...');
}
