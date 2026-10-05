/**
 * Default API-key name suggestion: `selora-cli-<sanitized-hostname>`, capped
 * under the backend's 120-char name limit. Shared by login (Path A) and
 * `keys create`.
 */

import { hostname } from 'node:os';

const KEYNAME_PREFIX = 'selora-cli-';

export function suggestedKeyName(): string {
  const host = hostname().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 100);
  return `${KEYNAME_PREFIX}${host}`;
}
