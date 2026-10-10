/** Windows names are case-insensitive; POSIX names need to remain distinct. */
export const normPath = (path: string): string => /^[a-z]:[\\/]/i.test(path) || /^(\\\\|\/\/)/.test(path)
  ? path.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '')
  : path.replace(/\/+$/, '')
