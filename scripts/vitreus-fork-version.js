// Vitreus fork identity.
//
// `version` in package.json stays the upstream release we rebased onto, so the
// provenance of every file is obvious. `vitreusFork.revision` counts our own
// patches on top of that base. Anything user-visible is built as
// "<upstream>-<name>" (revision 1) or "<upstream>-<name>.<revision>" (later
// patches), so a Vitreus build can never be mistaken for an upstream ignis
// release. The suffix survives the update check: packages/bridge/src/util/
// version.js parses only the first three dot-separated integers, so
// parseInt("0.8.11-mod") still yields [0, 8, 11].
const pkg = require("../package.json");

const fork = pkg.vitreusFork || { name: "mod", revision: 0 };

function forkVersion() {
  const base = pkg.version + "-" + fork.name;
  return fork.revision > 1 ? base + "." + fork.revision : base;
}

module.exports = { forkVersion, fork };
