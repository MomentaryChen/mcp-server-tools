import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { parseRoots, readFileLimited, resolveAllowedPath } from "../modules/files.js";

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "files-test-")));
const root = path.join(tmp, "root");
const sibling = path.join(tmp, "root-sibling");
fs.mkdirSync(path.join(root, "sub"), { recursive: true });
fs.mkdirSync(sibling);
fs.writeFileSync(path.join(root, "sub", "a.txt"), "hello");
fs.writeFileSync(path.join(sibling, "b.txt"), "secret");
fs.writeFileSync(path.join(tmp, "..dots.txt"), "x");
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("parseRoots: empty means no restriction, missing directory throws", () => {
  assert.deepEqual(parseRoots(undefined), []);
  assert.deepEqual(parseRoots("  "), []);
  assert.deepEqual(parseRoots(`${root}${path.delimiter}${sibling}`), [root, sibling]);
  assert.throws(() => parseRoots(path.join(tmp, "nope")), /FILES_ROOTS/);
});

test("resolveAllowedPath: files under a root are allowed", async () => {
  const roots = [root];
  assert.equal(await resolveAllowedPath(path.join(root, "sub", "a.txt"), roots), path.join(root, "sub", "a.txt"));
  assert.equal(await resolveAllowedPath(path.join(root, "sub", "..", "sub", "a.txt"), roots), path.join(root, "sub", "a.txt"));
  assert.equal(await resolveAllowedPath(root, roots), root);
});

test("resolveAllowedPath: traversal and prefix-sharing siblings are refused", async () => {
  const roots = [root];
  await assert.rejects(resolveAllowedPath(path.join(root, "..", "root-sibling", "b.txt"), roots), /FILES_ROOTS/);
  await assert.rejects(resolveAllowedPath(path.join(sibling, "b.txt"), roots), /FILES_ROOTS/);
  await assert.rejects(resolveAllowedPath(path.join(tmp, "..dots.txt"), roots), /FILES_ROOTS/);
});

test("resolveAllowedPath: no roots allows any existing path; missing file rejects", async () => {
  assert.equal(await resolveAllowedPath(path.join(sibling, "b.txt"), []), path.join(sibling, "b.txt"));
  await assert.rejects(resolveAllowedPath(path.join(root, "missing.txt"), [root]), /ENOENT/);
});

test("resolveAllowedPath: a symlink pointing outside the root is refused", async (t) => {
  const link = path.join(root, "link.txt");
  try {
    fs.symlinkSync(path.join(sibling, "b.txt"), link);
  } catch {
    t.skip("symlinks not permitted on this system");
    return;
  }
  await assert.rejects(resolveAllowedPath(link, [root]), /FILES_ROOTS/);
});

test("readFileLimited: cuts at maxBytes without a broken multi-byte character", async () => {
  const file = path.join(root, "utf8.txt");
  fs.writeFileSync(file, "ab中文");
  assert.deepEqual(await readFileLimited(file, 100), { text: "ab中文", size: 8, truncated: false });
  const cut = await readFileLimited(file, 4); // "ab" + 2 of 3 bytes of 中
  assert.equal(cut.text, "ab");
  assert.equal(cut.truncated, true);
});

test("resolveAllowedPath: a directory junction / link pointing outside the root is refused", async () => {
  // "junction" needs no privilege on Windows; the type is ignored elsewhere (plain dir symlink).
  const linkDir = path.join(root, "linkdir");
  fs.symlinkSync(sibling, linkDir, "junction");
  await assert.rejects(resolveAllowedPath(path.join(linkDir, "b.txt"), [root]), /FILES_ROOTS/);
  assert.equal(await resolveAllowedPath(path.join(linkDir, "b.txt"), [sibling]), path.join(sibling, "b.txt"));
});
