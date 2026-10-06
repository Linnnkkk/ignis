import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { creationTime } = require("./file-times.js");

describe("creationTime", () => {
  it("is the birth time when it precedes the last modification", () => {
    expect(
      creationTime({ birthtimeMs: 1000, mtimeMs: 5000, ctimeMs: 9000 }),
    ).toBe(1000);
  });

  it("is the modification time when the filesystem records no birth time", () => {
    expect(creationTime({ birthtimeMs: 0, mtimeMs: 5000, ctimeMs: 9000 })).toBe(
      5000,
    );
  });

  it("is the modification time when the birth time is later", () => {
    expect(
      creationTime({ birthtimeMs: 9000, mtimeMs: 5000, ctimeMs: 9000 }),
    ).toBe(5000);
  });
});
