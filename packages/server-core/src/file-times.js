function creationTime(stat) {
  return stat.birthtimeMs > 0
    ? Math.min(stat.birthtimeMs, stat.mtimeMs) // don't allow creation time after modification time
    : stat.mtimeMs;
}

module.exports = { creationTime };
