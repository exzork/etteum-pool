/**
 * Shared sync state flags — extracted to avoid circular imports.
 */

// When true, the change tracker won't emit deltas (prevents echo loops
// when applying remote changes to local DB).
let _suppressEmit = false;

export function getSuppressEmit(): boolean {
  return _suppressEmit;
}

export function setSuppressEmit(value: boolean) {
  _suppressEmit = value;
}
