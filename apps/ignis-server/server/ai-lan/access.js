// Service-wide local-owner policy. Never remotely writable by an MCP client.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
function createAccessPolicy(dataDir, knownVaults) {
  const file = path.join(dataDir, 'access.json');
  let policy = { vaultIds: [], allowWrite: false };
  const validate = (value) => {
    if (!value || !Array.isArray(value.vaultIds) || value.vaultIds.length > 100 ||
        typeof value.allowWrite !== 'boolean' || value.vaultIds.some(id => typeof id !== 'string' || !Object.hasOwn(knownVaults(), id))) {
      throw Object.assign(new Error('Invalid vault access policy'), { code: 'BAD_REQUEST' });
    }
    return { vaultIds: [...new Set(value.vaultIds)], allowWrite: value.allowWrite };
  };
  try { if (fs.statSync(file).isFile() && fs.statSync(file).size <= 65536) policy = validate(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* Fail closed, including unknown legacy grants. */ }
  return {
    status: () => ({ vaultIds: [...policy.vaultIds], allowWrite: policy.allowWrite }),
    allows: (id, write = false) => policy.vaultIds.includes(id) && (!write || policy.allowWrite),
    update(value) {
      const next = validate(value);
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const temp = `${file}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, file);
      policy = next;
      return this.status();
    },
  };
}
module.exports = { createAccessPolicy };
