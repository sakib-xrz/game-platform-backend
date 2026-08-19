declare module 'heic-convert' {
  type ConvertOptions = { buffer: Buffer; format: 'JPEG' | 'PNG'; quality?: number };
  const convert: (options: ConvertOptions) => Promise<Buffer | Uint8Array>;
  export default convert;
}
