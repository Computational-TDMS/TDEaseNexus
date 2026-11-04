"use strict";

const fs = require("node:fs");
const path = require("node:path");

function comparisonPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isContained(candidate, root) {
  const relative = path.relative(comparisonPath(root), comparisonPath(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function nearestExistingAncestor(target) {
  let current = path.resolve(target);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

function containedPath(root, relative, denial) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relative);
  if (!isContained(target, resolvedRoot)) throw new Error(denial);
  if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
    throw new Error(`contained root does not exist: ${resolvedRoot}`);
  }

  const realRoot = fs.realpathSync.native(resolvedRoot);
  const existing = nearestExistingAncestor(target);
  if (!existing) throw new Error(denial);
  const realExisting = fs.realpathSync.native(existing);
  if (!isContained(realExisting, realRoot)) throw new Error(denial);

  if (fs.existsSync(target)) {
    const realTarget = fs.realpathSync.native(target);
    if (!isContained(realTarget, realRoot)) throw new Error(denial);
  }
  return target;
}

module.exports = { containedPath, isContained };
