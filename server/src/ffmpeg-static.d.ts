// Optional dependency; may be missing at runtime, so it is always imported dynamically.
declare module 'ffmpeg-static' {
  const path: string | null;
  export default path;
}
