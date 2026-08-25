const { walkTree, getOrBuild, warmUp } = require("./crawl");
const { applyMutation } = require("./apply");
const { getOrCompress } = require("./compress");
const {
  invalidateVault,
  invalidateAll,
  markForRevalidation,
} = require("./invalidate");

module.exports = {
  walkTree,
  getOrBuild,
  getOrCompress,
  applyMutation,
  invalidateVault,
  invalidateAll,
  markForRevalidation,
  warmUp,
};
