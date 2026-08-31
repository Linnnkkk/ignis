const { walkTree, getOrBuild, warmUp } = require("./crawl");
const { applyMutation } = require("./apply");
const { getOrCompress } = require("./compress");
const {
  invalidateVault,
  invalidateAll,
  markForRevalidation,
} = require("./invalidate");
const { onEntrySwapped, onVaultInvalidated } = require("./state");

module.exports = {
  walkTree,
  getOrBuild,
  getOrCompress,
  applyMutation,
  invalidateVault,
  invalidateAll,
  markForRevalidation,
  onEntrySwapped,
  onVaultInvalidated,
  warmUp,
};
