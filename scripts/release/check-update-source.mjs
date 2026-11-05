#!/usr/bin/env node
// Verify the update source an installed TDEaseNexus client actually uses.
//
// Mirrors the requests electron-updater's GitHub provider makes:
//   GET https://github.com/<slug>/releases/latest                (Accept: application/json)
//   GET https://github.com/<slug>/releases.atom                  (Accept: atom+xml)
//   GET https://github.com/<slug>/releases/download/<tag>/<channel file>
// and follows redirects manually with the updater's own limit (10 hops,
// electron-updater ElectronHttpExecutor.maxRedirects), printing every hop.
// A feed repository that only resolves through a GitHub transfer redirect is
// therefore visible instead of silently passing.
//
// Usage:
//   node scripts/release/check-update-source.mjs --slug owner/repo \
//        [--platform win32|linux|darwin] [--expect-version 0.11.0-beta]
//
// Exit code 0 = the update source resolves and advertises the expected version.

const MAX_REDIRECTS = 10;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[(i += 1)] : "true";
    out[name] = value;
  }
  return out;
}

function channelFile(platform) {
  if (platform === "win32") return "latest.yml";
  if (platform === "darwin") return "latest-mac.yml";
  if (platform === "linux") return "latest-linux.yml";
  throw new Error(`unsupported platform: ${platform}`);
}

async function request(url, headers = {}) {
  const hops = [];
  let current = url;
  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    const response = await fetch(current, { headers, redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`${current} returned ${response.status} without Location`);
      hops.push({ status: response.status, from: current, to: location });
      current = new URL(location, current).toString();
      continue;
    }
    const body = await response.text();
    return { url: current, status: response.status, body, hops };
  }
  throw new Error(`more than ${MAX_REDIRECTS} redirects starting at ${url}`);
}

function shorten(url) {
  const text = String(url);
  return text.length > 100 ? `${text.slice(0, 92)}…` : text;
}

function reportHops(label, hops) {
  if (hops.length === 0) {
    console.log(`  [ok] ${label}: no redirect`);
    return;
  }
  for (const hop of hops) {
    console.log(`  [redirect] ${label}: ${hop.status} ${shorten(hop.from)} -> ${shorten(hop.to)}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const slug = args.slug;
  const platform = args.platform || process.platform;
  const expected = args["expect-version"];
  if (!slug || !/^[^/]+\/[^/]+$/.test(slug)) {
    console.error("usage: node scripts/release/check-update-source.mjs --slug owner/repo [--platform win32|linux|darwin] [--expect-version X]");
    process.exit(2);
  }

  const failures = [];
  const base = `https://github.com/${slug}`;
  const file = channelFile(platform);
  console.log(`=== update source: ${slug} (platform ${platform}, channel file ${file}) ===`);

  // 1. /releases/latest -- electron-updater's getLatestTagName for github.com.
  const latest = await request(`${base}/releases/latest`, { accept: "application/json" });
  const tag = (() => {
    try {
      return JSON.parse(latest.body).tag_name;
    } catch {
      return null;
    }
  })();
  reportHops("/releases/latest", latest.hops);
  if (latest.status !== 200 || !tag) {
    failures.push(`/releases/latest did not return a release tag (status ${latest.status})`);
  } else {
    console.log(`  [ok] latest tag: ${tag}`);
  }

  // 2. releases.atom -- the channel feed getLatestVersion() parses first.
  const atom = await request(`${base}/releases.atom`, {
    accept: "application/xml, application/atom+xml, text/xml, */*",
  });
  reportHops("releases.atom", atom.hops);
  const tagInFeed = tag && atom.body.includes(`/tag/${tag}`);
  if (atom.status !== 200 || !tagInFeed) {
    failures.push(`releases.atom does not advertise ${tag ?? "(no tag)"}`);
  } else {
    console.log(`  [ok] atom feed advertises ${tag}`);
  }

  // 3. Channel file the client downloads (following the tag from step 1).
  if (tag) {
    const channelUrl = `${base}/releases/download/${tag}/${file}`;
    const channel = await request(channelUrl, { accept: "text/yaml, text/plain, */*" });
    reportHops(`download/${tag}/${file}`, channel.hops);
    const match = /^version:\s*(\S+)\s*$/m.exec(channel.body);
    if (channel.status !== 200 || !match) {
      failures.push(`${channelUrl} is not a valid channel file (status ${channel.status})`);
    } else {
      console.log(`  [ok] ${file} advertises version: ${match[1]}`);
      if (expected && match[1] !== expected) {
        failures.push(`${file} advertises ${match[1]}, expected ${expected}`);
      }
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`  [FAIL] ${failure}`);
    console.error("=== update source: FAILED ===");
    process.exit(1);
  }
  console.log("=== update source: OK ===");
}

main().catch((error) => {
  console.error(`  [FAIL] ${error.message}`);
  console.error("=== update source: FAILED ===");
  process.exit(1);
});
