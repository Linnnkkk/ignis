// Drop-in replacement for require("fs") that routes paths mounted by the
// remote vault registry to their WebDAV backend, and everything else to Node's
// fs untouched.
//
// Why a dispatcher instead of editing every route: routes/fs.js alone has 27
// fs.promises call sites across 12 operations, and cache/crawl.js walks the
// vault with the same API. Swapping the require keeps all of that code as-is,
// so local vaults behave exactly as before and a remote vault looks like a
// directory that happens to be slow.
//
// Only the async API is routed. Sync calls, existence checks and streams all
// fall through to real fs: the mount point itself is a real (empty) directory,
// so anything that merely probes it keeps working.

const realFs = require("fs");
const { backendForPath, backendForVaultId } = require("./registry");

// Operations performed inside a mounted vault. Everything else is Node's fs.
const ROUTED = [
  "stat",
  "lstat",
  "readFile",
  "writeFile",
  "appendFile",
  "mkdir",
  "rmdir",
  "rm",
  "unlink",
  "rename",
  "copyFile",
  "utimes",
  "access",
  "readdir",
];

function encodingOf(options) {
  if (typeof options === "string") {
    return options;
  }

  if (options && typeof options === "object") {
    return options.encoding || null;
  }

  return null;
}

// WebDAV has MKCOL, which cannot create intermediate levels, so recursive
// mkdir has to walk down one segment at a time.
async function mkdirRecursive(backend, rel, created) {
  if (rel === "") {
    return;
  }

  const segments = rel.split("/");
  let prefix = "";

  for (const segment of segments) {
    prefix = prefix === "" ? segment : prefix + "/" + segment;
    created.push(prefix);
  }

  let walked = "";

  for (const target of created) {
    walked = target;

    try {
      await backend.mkdir(walked);
    } catch (e) {
      if (e.code === "EEXIST") {
        continue;
      }

      throw e;
    }
  }

  return walked;
}

async function runRemote(backend, rel, name, args) {
  switch (name) {
    case "stat":
    case "lstat":
      return backend.stat(rel);

    case "readFile":
      return backend.readFile(rel, encodingOf(args[0]));

    case "writeFile":
      return backend.writeFile(rel, args[0], encodingOf(args[1]));

    case "appendFile":
      return backend.appendFile(rel, args[0], encodingOf(args[1]));

    case "mkdir": {
      const options = args[0];

      if (options && typeof options === "object" && options.recursive) {
        const created = [];

        try {
          await mkdirRecursive(backend, rel, created);
        } catch (e) {
          if (e.code === "EEXIST" && !options.recursive) {
            throw e;
          }

          throw e;
        }

        // Node returns the first created directory when recursive; returning
        // undefined is also accepted, and nothing in the routes reads it.
        return undefined;
      }

      await backend.mkdir(rel);
      return undefined;
    }

    case "readdir": {
      const list = await backend.readdir(rel);

      // Default fs.readdir yields names; withFileTypes yields Dirents.
      const wantTypes = Boolean(
        args[0] && typeof args[0] === "object" && args[0].withFileTypes,
      );

      return wantTypes ? list : list.map((entry) => entry.name);
    }

    case "rmdir":
      return backend.rmdir(rel);

    case "rm": {
      const options = args[0] && typeof args[0] === "object" ? args[0] : {};

      return backend.rm(rel, options);
    }

    case "unlink":
      return backend.unlink(rel);

    case "rename": {
      const target = args[0];
      const mapped = backendForPath(target);

      if (!mapped || mapped.backend !== backend) {
        // Cross-backend moves are not supported (and cannot be atomic).
        const err = new Error(
          "EXDEV: cannot move between the remote vault and another location",
        );

        err.code = "EXDEV";
        throw err;
      }

      return backend.rename(rel, mapped.rel);
    }

    case "copyFile": {
      const target = args[0];
      const mapped = backendForPath(target);

      if (!mapped || mapped.backend !== backend) {
        const err = new Error(
          "EXDEV: cannot copy between the remote vault and another location",
        );

        err.code = "EXDEV";
        throw err;
      }

      return backend.copyFile(rel, mapped.rel);
    }

    case "utimes":
      return backend.utimes(rel, args[0], args[1]);

    case "access":
      return backend.access(rel);

    default: {
      const err = new Error("ENOTSUP: " + name + " is not routed for remote vaults");

      err.code = "ENOTSUP";
      throw err;
    }
  }
}

const promises = Object.create(realFs.promises);

for (const name of ROUTED) {
  promises[name] = async function routed(pathOrFd, ...args) {
    if (typeof pathOrFd !== "string") {
      // File descriptors only exist for local files.
      return realFs.promises[name](pathOrFd, ...args);
    }

    if (name === "rename" || name === "copyFile") backendForPath(args[0]);
    const mapped = backendForPath(pathOrFd);

    if (!mapped) {
      return realFs.promises[name](pathOrFd, ...args);
    }

    return runRemote(mapped.backend, mapped.rel, name, args);
  };
}

// Streams: local files get a real stream. A remote file is wrapped in a
// PassThrough fed by a ranged GET, so archiver (download-zip) keeps working and
// large files are never fully buffered in memory.
function createReadStream(target, options = {}) {
  const mapped = backendForPath(target);

  if (!mapped) {
    return realFs.createReadStream(target, options);
  }

  const { PassThrough } = require("stream");
  const out = new PassThrough();

  mapped.backend
    .openReadStream(mapped.rel, {
      start: options.start,
      end: options.end,
    })
    .then(({ status, stream }) => {
      const acceptable = status === 200 || status === 206;

      if (!acceptable) {
        out.destroy(
          Object.assign(new Error("WebDAV stream failed (HTTP " + status + ")"), {
            code: status === 404 ? "ENOENT" : "EIO",
          }),
        );
        stream.resume();
        return;
      }

      stream.on("error", (e) => out.destroy(e));
      stream.pipe(out);
    })
    .catch((e) => out.destroy(e));

  return out;
}

function createWriteStream(target, options = {}) {
  const mapped = backendForPath(target);

  if (!mapped) {
    return realFs.createWriteStream(target, options);
  }

  // WebDAV PUT replaces the whole resource, so a write stream has to buffer
  // and flush on end rather than stream incrementally.
  const { PassThrough } = require("stream");
  const sink = new PassThrough();
  const chunks = [];

  sink.on("data", (chunk) => chunks.push(chunk));
  sink.on("finish", () => {
    mapped.backend
      .writeFile(mapped.rel, Buffer.concat(chunks))
      .catch((e) => sink.destroy(e));
  });

  return sink;
}

module.exports = Object.assign({}, realFs, {
  promises,
  createReadStream,
  createWriteStream,
  // Exposed for callers that need to ask directly.
  isRemotePath: (p) => backendForPath(p) !== null,
  backendForVaultId,
});
