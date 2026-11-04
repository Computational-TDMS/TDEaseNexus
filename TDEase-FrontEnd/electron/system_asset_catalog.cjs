"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const { containedPath } = require("./path_containment.cjs");

function createSystemAssetCatalog({ productRoot }) {
  const root = path.resolve(productRoot);

  async function filesFor(relative) {
    const base = containedPath(root, relative, "system asset path traversal denied");
    const files = [];
    try { await fs.access(base); } catch { return files; }
    async function walk(directory) {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(absolute);
        else if (entry.isFile()) files.push(path.relative(base, absolute).split(path.sep).join("/"));
      }
    }
    await walk(base);
    return files.sort();
  }

  return Object.freeze({
    async resolvePath(relative) {
      if (typeof relative !== "string" || !relative) throw new Error("system asset path is required");
      const candidate = containedPath(root, relative, "system asset path traversal denied");
      try { await fs.access(candidate); } catch { throw new Error(`Unknown System asset: ${relative}`); }
      return candidate;
    },
    listFiles(relative) {
      return filesFor(relative);
    },
    async readText(relative) {
      if (typeof relative !== "string" || !relative) throw new Error("system asset path is required");
      const [category, identity] = relative.split(/[\\/]/);
      if (!category || !identity) throw new Error("system asset reads require a category and asset identity");
      try {
        return await fs.readFile(containedPath(root, relative, "system asset path traversal denied"), "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") throw new Error(`Unknown System asset: ${relative}`);
        throw error;
      }
    },
  });
}

module.exports = { createSystemAssetCatalog };
