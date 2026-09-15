const { spawn, execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const LOGIN_TIMEOUT_MS = 30000;
const BAD_CREDENTIALS_TEXT = "double check your email and password";
const OVERLOAD_TEXT = "Unexpected token";

let obHome = null;

function init(opts) {
  obHome = opts && opts.obHome ? opts.obHome : null;

  if (obHome) {
    try {
      fs.mkdirSync(obHome, { recursive: true });
    } catch {}
  }
}

function getObHome() {
  return obHome || os.homedir();
}

function authTokenFileIn(home) {
  // ob uses .config on Linux only
  const configDir =
    process.platform === "linux"
      ? path.join(home, ".config", "obsidian-headless")
      : path.join(home, ".obsidian-headless");

  return path.join(configDir, "auth_token");
}

function getAuthTokenFile() {
  return authTokenFileIn(getObHome());
}

function obEnv(home) {
  const env = { ...process.env, HOME: home };

  // make sure ob uses HOME and its token file
  delete env.XDG_CONFIG_HOME;
  delete env.OBSIDIAN_AUTH_TOKEN;

  return env;
}

function checkInstalled() {
  try {
    const output = execSync("ob --version", {
      stdio: "pipe",
      windowsHide: true,
    })
      .toString()
      .trim();

    return { installed: true, version: output || "unknown" };
  } catch {
    return { installed: false, version: null };
  }
}

function spawnOb(args, opts = {}) {
  return spawn("ob", args, {
    env: obEnv(getObHome()),
    shell: false,
    windowsHide: true,
    ...opts,
  });
}

function runCommand(args, opts = {}) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    const proc = spawnOb(args, opts);

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(`ob ${args[0]} failed (code ${code}): ${stderr || stdout}`),
        );
      }
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}

function readTokenFile(file) {
  try {
    return fs.readFileSync(file, "utf-8").trim();
  } catch {
    return "";
  }
}

function writeAuthToken(token) {
  const file = getAuthTokenFile();

  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, token, { encoding: "utf-8", mode: 0o600 });

  try {
    // if file already existed
    fs.chmodSync(file, 0o600);
  } catch {}
}

function classifyLogin({ code, stdout, stderr, email, scratchHome }) {
  if (stderr.includes(BAD_CREDENTIALS_TEXT)) {
    return { outcome: "bad-credentials" };
  }

  if (stderr.includes(OVERLOAD_TEXT)) {
    return { outcome: "overload" };
  }

  if (code !== 0) {
    return {
      outcome: "error",
      message: stderr.trim() || `ob login exited with code ${code}`,
    };
  }

  const token = readTokenFile(authTokenFileIn(scratchHome));

  if (!token) {
    return { outcome: "error", message: "ob login wrote no auth token" };
  }

  const loggedIn = stdout.match(/Logged in as (.+) \(/);

  return {
    outcome: "ok",
    token,
    name: loggedIn ? loggedIn[1] : null,
    email,
  };
}

function login({ email, password, mfa }) {
  const args = ["login", "--email", email];

  if (typeof mfa === "string" && mfa !== "") {
    args.push("--mfa", mfa);
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let scratchHome;
    let proc;

    try {
      // use temp dir to avoid ob sign out
      scratchHome = fs.mkdtempSync(path.join(getObHome(), "login-"));
    } catch (e) {
      resolve({ outcome: "error", message: e.message });
      return;
    }

    function settle(outcome) {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);

      try {
        fs.rmSync(scratchHome, { recursive: true, force: true });
      } catch {}

      resolve(outcome);
    }

    const timer = setTimeout(() => {
      if (proc) {
        proc.kill();
      }

      settle({ outcome: "error", message: "ob login timed out" });
    }, LOGIN_TIMEOUT_MS);

    const env = obEnv(scratchHome);

    try {
      proc = spawnOb(args, { env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      settle({ outcome: "error", message: e.message });
      return;
    }

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      const outcome = classifyLogin({
        code,
        stdout,
        stderr,
        email,
        scratchHome,
      });

      if (outcome.outcome === "ok") {
        try {
          writeAuthToken(outcome.token);
        } catch (e) {
          settle({ outcome: "error", message: e.message });
          return;
        }
      }

      settle(outcome);
    });

    proc.on("error", (err) => {
      settle({ outcome: "error", message: err.message });
    });

    proc.stdin.on("error", () => {});

    // use stdin instead of argument for security
    proc.stdin.end(password);
  });
}

module.exports = {
  init,
  getObHome,
  getAuthTokenFile,
  checkInstalled,
  spawnOb,
  runCommand,
  login,
};
