const SUPPORTED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

export function detectImageMime(bytes: Buffer, headerMime?: string) {
  // 字节魔数是真相：header 可能被代理改写或与内容不符，先嗅探再回退 header。
  if (bytes.length >= 12) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) return "image/webp";
  }
  if (headerMime && SUPPORTED_IMAGE_MIME.has(headerMime)) return headerMime;
  return undefined;
}
