/**
 * Content-Disposition for a file whose name came from a user. Header values must be
 * Latin-1, and Node throws on anything else (e.g. "ɛ" or an emoji from a phone), so the
 * plain `filename` gets an ASCII stand-in and the real name goes in `filename*` (RFC 6266).
 */
export function contentDisposition(fileName: string, type: 'inline' | 'attachment' = 'inline'): string {
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, '_').trim() || 'file';
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
