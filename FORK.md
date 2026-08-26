# Why this fork exists

A fork of [Swatinem/rust-cache](https://github.com/Swatinem/rust-cache) adding a
**`cacheflow`** cache provider, so the organisation's Rust workflows cache
through [CacheFlow](https://github.com/CaptainEmpower/cacheflow) instead of
GitHub.

## Why a fork was necessary

`@actions/cache` cannot be pointed at another backend. The runner supplies its
own `ACTIONS_*` values when it invokes a JavaScript action, so neither
`$GITHUB_ENV` nor a step-level `env:` block redirects it. Both were measured on
the self-hosted fleet: entries went to GitHub's cache while the job looked
correctly configured — a shell step in the same job echoed the CacheFlow URL.

rust-cache selects its backend by `switch`-ing over `cache-provider` and
dynamically importing a package. That is a compile-time choice, not a plugin
point, so a provider cannot be injected from outside. `warpbuild` is in the
tree for exactly the same reason.

## What diverges from upstream

Three files, deliberately kept minimal so rebasing stays cheap:

| file | change |
| --- | --- |
| `src/cacheflowCache.ts` | **new** — the provider |
| `src/utils.ts` | one `case "cacheflow":` in the provider switch |
| `action.yml` | `cache-provider` description lists the new value |

Plus the rebuilt `dist/`, which upstream also commits.

## Usage

```yaml
permissions:
  contents: read
  id-token: write          # required; never granted by the org default

steps:
  - uses: CaptainEmpower/rust-cache@v2-cacheflow
    with:
      cache-provider: cacheflow
    env:
      CACHEFLOW_CACHE_URL: ${{ vars.CACHEFLOW_CACHE_URL }}
```

Configuration is read from the environment rather than a new action input, so
upstream's `action.yml` surface is untouched apart from the description:

| variable | |
| --- | --- |
| `CACHEFLOW_CACHE_URL` | required — the service origin |
| `CACHEFLOW_OIDC_AUDIENCE` | optional — defaults to `api://cacheflow-cache` |

## Failure behaviour

A cache failure never fails a build. Restore returns a miss and save reports a
warning, so the job degrades to a cold cache rather than breaking. The trade is
that **cache breakage is quiet** — verify with the service, not the job badge:

```bash
gh api "repos/$OWNER/$REPO/actions/caches?key=$KEY" --jq '.total_count'
# 0 → served by CacheFlow
```

## Keeping up with upstream

```bash
git remote add upstream https://github.com/Swatinem/rust-cache.git
git fetch upstream
git rebase upstream/master
npm ci && npm run build      # dist is committed; rebuild after every rebase
```

The divergence is three files, so conflicts should be limited to `src/utils.ts`
when upstream edits the provider switch.

## Licence

Upstream is **LGPL-3.0**, and this fork inherits it — including
`src/cacheflowCache.ts`, which is part of the combined work. Internal use across
the organisation is not distribution, but if this action is ever published or
shared outside it, the modified source must be offered under LGPL-3.0. The
`LICENSE` file and upstream's notices are retained unchanged.
