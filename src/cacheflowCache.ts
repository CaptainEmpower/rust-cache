/**
 * CacheFlow backend for `cache-provider: cacheflow`.
 *
 * `@actions/cache` cannot be pointed at another service: the runner supplies its
 * own `ACTIONS_*` values when it invokes a JavaScript action, so neither
 * `$GITHUB_ENV` nor a step-level `env:` redirects it. Measured on a self-hosted
 * fleet — both attempts wrote every byte to GitHub's cache while the job looked
 * correctly configured. A provider that talks to the service directly is the way
 * round that, which is the same shape the `warpbuild` provider takes.
 *
 * Speaks CacheFlow's v1 REST protocol:
 *
 *   GET   /_apis/artifactcache/cache?keys=&version=   look up
 *   POST  /_apis/artifactcache/caches                 reserve
 *   PATCH /_apis/artifactcache/caches/{id}            upload, in parts
 *   POST  /_apis/artifactcache/caches/{id}            commit
 *
 * Configuration comes from the environment rather than an action input, so the
 * upstream `action.yml` needs no new surface:
 *
 *   CACHEFLOW_CACHE_URL       required; the service origin
 *   CACHEFLOW_OIDC_AUDIENCE   optional; defaults to api://cacheflow-cache
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "@actions/core";
import { exec } from "@actions/exec";

/** Must equal the server's PART_SIZE: it derives the R2 part number from the
 * byte offset, so any other chunk size collides parts. */
const PART_SIZE = 32 * 1024 * 1024;

const DEFAULT_AUDIENCE = "api://cacheflow-cache";

function baseUrl(): string {
  const raw = process.env.CACHEFLOW_CACHE_URL ?? "";
  if (!raw) {
    throw new Error(
      "CACHEFLOW_CACHE_URL is not set. Pass it from the CACHEFLOW_CACHE_URL organisation variable.",
    );
  }
  return raw.replace(/\/+$/, "");
}

/**
 * Mint a GitHub OIDC token for CacheFlow.
 *
 * Minted per call rather than read from `ACTIONS_RUNTIME_TOKEN`, which belongs
 * to GitHub's own services and CacheFlow rejects as unverifiable.
 */
async function mintToken(): Promise<string> {
  const audience = process.env.CACHEFLOW_OIDC_AUDIENCE || DEFAULT_AUDIENCE;
  const token = await core.getIDToken(audience);
  if (!token) {
    throw new Error(
      "Could not mint an OIDC token. The job needs `permissions: id-token: write` — " +
        "GitHub never grants it through the organisation default.",
    );
  }
  return token;
}

/**
 * A stable identifier for "what shape of archive is this".
 *
 * Mirrors what `@actions/cache` calls `version`: entries are only interchangeable
 * when the paths and platform match, so it belongs in the lookup rather than in
 * the user-facing key.
 */
function computeVersion(paths: string[]): string {
  const hash = crypto.createHash("sha256");
  for (const p of [...paths].sort()) {
    hash.update(`${p}\n`);
  }
  hash.update(`${process.env.RUNNER_OS ?? os.platform()}\n`);
  hash.update(`${process.env.RUNNER_ARCH ?? os.arch()}\n`);
  hash.update("tar-gz-v1\n");
  return hash.digest("hex");
}

async function request(
  url: string,
  init: RequestInit & { token: string },
): Promise<Response> {
  const { token, ...rest } = init;
  return fetch(url, {
    ...rest,
    headers: { ...(rest.headers ?? {}), Authorization: `Bearer ${token}` },
  });
}

/**
 * Whether this provider can be used at all.
 *
 * Deliberately does not mint a token: `isFeatureAvailable` is called on the
 * synchronous path and a network round trip there would slow every job to
 * answer a question configuration already answers.
 */
export function isFeatureAvailable(): boolean {
  return Boolean(process.env.CACHEFLOW_CACHE_URL);
}

/**
 * Restore the first key that matches, honouring `restoreKeys` as prefixes.
 *
 * Returns the matched key, or `undefined` for a miss — the contract
 * `@actions/cache` defines and rust-cache branches on.
 */
export async function restoreCache(
  paths: string[],
  primaryKey: string,
  restoreKeys?: string[],
  _options?: unknown,
  _enableCrossOsArchive?: boolean,
): Promise<string | undefined> {
  const base = baseUrl();
  const token = await mintToken();
  const version = computeVersion(paths);
  const keys = [primaryKey, ...(restoreKeys ?? [])].filter(Boolean);

  const lookup = new URL(`${base}/_apis/artifactcache/cache`);
  lookup.searchParams.set("keys", keys.join(","));
  lookup.searchParams.set("version", version);

  const res = await request(lookup.toString(), { token });
  if (res.status === 204) {
    core.info(`CacheFlow: no entry for ${primaryKey}`);
    return undefined;
  }
  if (!res.ok) {
    // A restore failure must never fail the build: the caller treats undefined
    // as a miss, which degrades to a cold cache rather than a broken job.
    core.warning(`CacheFlow lookup failed with HTTP ${res.status}`);
    return undefined;
  }

  const body = (await res.json()) as { cacheKey: string; archiveLocation: string };
  const location = /^https?:\/\//.test(body.archiveLocation)
    ? body.archiveLocation
    : `${base}${body.archiveLocation}`;

  const archive = path.join(os.tmpdir(), `cacheflow-${crypto.randomUUID()}.tgz`);
  const download = await request(location, { token });
  if (!download.ok) {
    core.warning(`CacheFlow download failed with HTTP ${download.status}`);
    return undefined;
  }
  await fs.promises.writeFile(archive, Buffer.from(await download.arrayBuffer()));

  // Absolute members (-P): cargo caches live outside the workspace, under
  // ~/.cargo, which a workspace-relative archive cannot represent.
  await exec("tar", ["-xzf", archive, "-P"]);
  await fs.promises.rm(archive, { force: true });

  core.info(`CacheFlow: restored ${body.cacheKey}`);
  return body.cacheKey;
}

/**
 * Save an entry.
 *
 * Returns a truthy id on success. A failure here is reported and swallowed for
 * the same reason as restore: a cache that cannot be written should slow the
 * next build, not fail this one.
 */
export async function saveCache(paths: string[], key: string): Promise<string | number> {
  const base = baseUrl();
  const token = await mintToken();
  const version = computeVersion(paths);

  const present: string[] = [];
  for (const p of paths) {
    if (fs.existsSync(p)) present.push(p);
    else core.debug(`CacheFlow: path not found, skipping: ${p}`);
  }
  if (present.length === 0) {
    core.warning(`CacheFlow: nothing to save for ${key}`);
    return 0;
  }

  const archive = path.join(os.tmpdir(), `cacheflow-${crypto.randomUUID()}.tgz`);
  await exec("tar", ["-czf", archive, "-P", ...present]);
  const size = (await fs.promises.stat(archive)).size;

  const reserve = await request(`${base}/_apis/artifactcache/caches`, {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, version, cacheSize: size }),
  });

  if (reserve.status === 409) {
    // Another job committed this key first, which is success: the entry exists.
    core.info(`CacheFlow: ${key} already exists`);
    await fs.promises.rm(archive, { force: true });
    return 0;
  }
  if (!reserve.ok) {
    await fs.promises.rm(archive, { force: true });
    core.warning(`CacheFlow reserve failed with HTTP ${reserve.status}`);
    return 0;
  }

  const { cacheId } = (await reserve.json()) as { cacheId: number };

  // Chunked: a single request cannot carry a cargo cache, which routinely
  // exceeds a gigabyte and returns HTTP 413.
  const handle = await fs.promises.open(archive, "r");
  try {
    for (let offset = 0; offset < size; offset += PART_SIZE) {
      const length = Math.min(PART_SIZE, size - offset);
      const buffer = Buffer.allocUnsafe(length);
      await handle.read(buffer, 0, length, offset);
      const upload = await request(`${base}/_apis/artifactcache/caches/${cacheId}`, {
        token,
        method: "PATCH",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Range": `bytes ${offset}-${offset + length - 1}/*`,
        },
        body: new Uint8Array(buffer),
      });
      if (!upload.ok) {
        core.warning(
          `CacheFlow upload of bytes ${offset}-${offset + length - 1} failed with HTTP ${upload.status}`,
        );
        return 0;
      }
    }
  } finally {
    await handle.close();
    await fs.promises.rm(archive, { force: true });
  }

  const commit = await request(`${base}/_apis/artifactcache/caches/${cacheId}`, {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ size }),
  });
  if (!commit.ok) {
    // Loud: an uncommitted reservation holds the key while serving nothing,
    // which presents as a cache that never warms up.
    core.warning(`CacheFlow commit failed with HTTP ${commit.status}`);
    return 0;
  }

  core.info(`CacheFlow: saved ${key} (${size} bytes)`);
  return cacheId;
}
