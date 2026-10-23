import { it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { createAccessPolicy } = createRequire(import.meta.url)('./access');
it('defaults closed and read-only, validates local grants and persists restrictions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-access-'));
  try {
    const policy = createAccessPolicy(root, () => ({ main: '/unused' }));
    expect(policy.allows('main')).toBe(false);
    policy.update({ vaultIds: ['main'], allowWrite: false });
    expect(policy.allows('main')).toBe(true);
    expect(policy.allows('main', true)).toBe(false);
    expect(() => policy.update({ vaultIds: ['unknown'], allowWrite: true })).toThrow();
    expect(createAccessPolicy(root, () => ({ main: '/unused' })).allows('main', true)).toBe(false);
    fs.writeFileSync(path.join(root, 'access.json'), 'corrupt');
    expect(createAccessPolicy(root, () => ({ main: '/unused' })).allows('main')).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
