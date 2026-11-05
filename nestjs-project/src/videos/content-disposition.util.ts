// Every code point outside printable ASCII (0x20–0x7E).
const NON_PRINTABLE_ASCII = /[^\x20-\x7E]/gu;
// Quoted-string breakers in the ASCII fallback.
const QUOTE_OR_BACKSLASH = /["\\]/g;
// Left as-is by encodeURIComponent but outside the RFC 5987 attr-char set.
const NON_ATTR_CHARS = /['()*]/g;

function percentEncode(char: string): string {
  return `%${char.charCodeAt(0).toString(16).toUpperCase()}`;
}

// RFC 6266 / RFC 5987: an ASCII fallback for old clients plus the exact
// UTF-8 name in `filename*`, so the download keeps the original file name.
export function buildAttachmentDisposition(originalFilename: string): string {
  const fallback = originalFilename
    .replace(NON_PRINTABLE_ASCII, '_')
    .replace(QUOTE_OR_BACKSLASH, '');
  const encoded = encodeURIComponent(originalFilename).replace(
    NON_ATTR_CHARS,
    percentEncode,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
