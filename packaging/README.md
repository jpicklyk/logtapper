# Packaging templates

`homebrew/logtapper.rb.tmpl`, `scoop/logtapper.json.tmpl` and `chocolatey/` are the
Homebrew cask, Scoop manifest and Chocolatey package for LogTapper, kept here as the
single source of truth and rendered by `scripts/render-packaging.mjs` for each release.
`.github/workflows/publish-packages.yml` runs the renderer on every published release.

The Homebrew and Scoop jobs push the rendered files to their publish-target repos
(`jpicklyk/homebrew-logtapper` as `Casks/logtapper.rb`, `jpicklyk/logtapper-scoop` as
`bucket/logtapper.json`) — this repo never ships those files directly, and neither target
repo carries anything else. Both target repos must exist with at least one commit (create
them with a README) before the workflow runs — `actions/checkout` cannot clone an empty
repository; the `Casks/` and `bucket/` directories are created on first push.

Chocolatey has no target repo: `choco pack` builds the `.nupkg` from the rendered
`chocolatey/` tree and `choco push` uploads it directly to the community feed
(community.chocolatey.org). That means the Homebrew/Scoop re-run safety (a clean git
tree — nothing to commit, so the job no-ops) doesn't apply; instead the `chocolatey` job
queries the public feed for `Id=logtapper,Version=$VERSION` before packing, and skips the
pack-and-push step when that version is already listed. A push that lands while the
version is still pending moderation isn't visible on that public feed yet, so a re-run
during moderation can still attempt the push — the job additionally tolerates a
409/"already exists" response from `choco push` as a no-op rather than a failure, since it
means an earlier run's push already landed. Every version, including the first, is pushed
by that job — the `CHOCO_API_KEY` secret is the only place the key lives. Verify a package
before its first push by rendering it locally and running `choco pack` + `choco install
logtapper --source .` in a sandbox; neither needs the key.

`chocolatey/logtapper.nuspec.tmpl` and `chocolatey/tools/chocolateyinstall.ps1.tmpl` are
templates; `chocolatey/tools/chocolateyuninstall.ps1` has no placeholders and is copied
through unmodified by the renderer so the output directory is a complete, packable
`choco pack` input.

To render locally against a real release:

```bash
node scripts/render-packaging.mjs --version 0.14.0 --out /tmp/packaging-out
```

This downloads the three release assets and hashes them; pass `--sha256
<asset-basename>=<hex>` (repeatable) to skip the download for a given asset, e.g. in tests
or offline. Pass `--icon-commit <sha>` to pin the Chocolatey nuspec's `iconUrl` to a
specific commit; it otherwise defaults to `git rev-parse HEAD`, falling back to the
literal `main` (with a warning) if that fails. `node scripts/render-packaging.mjs --check`
renders the committed templates against the current `package.json` version with dummy
hashes and a dummy icon commit, and fails if any `{{...}}` placeholder survives — run it
whenever a template changes. Script tests live in `scripts/render-packaging.test.mjs`, run
with `npm run test:scripts` (`node --test`, not part of `npm test`, which is the
Solid/vitest suite).
