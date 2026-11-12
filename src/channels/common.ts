// Split on Unicode code points, respecting each transport's byte limits.
export function splitText(text: string, maxBytes = 3000): string[] {
  if (maxBytes < 4) throw new Error('maxBytes must be at least 4');
  const parts: string[] = [];
  let part = '',
    size = 0;
  for (const character of text) {
    const bytes = Buffer.byteLength(character);
    if (size + bytes > maxBytes) {
      parts.push(part);
      part = '';
      size = 0;
    }
    part += character;
    size += bytes;
  }
  if (part) parts.push(part);
  return parts;
}
export function channelError(account: string): void {
  // SDK errors can contain signed webhook URLs or app secrets.
  console.error(
    `[${account}] channel error; check credentials, connectivity and platform permissions`,
  );
}
