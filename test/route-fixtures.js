/**
 * A structurally valid PNG header (signature + IHDR) shared by route tests.
 *
 * @returns {Buffer} the bytes.
 */
export function pngHeaderBytes() {
  const buffer = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'ascii')
  buffer.writeUInt32BE(12, 16)
  buffer.writeUInt32BE(34, 20)
  return buffer
}
