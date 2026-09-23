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

Before pushing, the Homebrew job lints the rendered cask with `brew style` and
`brew audit --online`, after a `brew update`. That checks it against the Homebrew users
have, not the copy baked into the runner image, which can trail it by weeks. The steps
live in `.github/actions/homebrew-lint/`, and `.github/workflows/verify-homebrew.yml` runs
the same action on every PR that touches `homebrew/`, the renderer or the action, so a
template change that breaks one of Homebrew's rules fails before merge instead of in the
publish run. That check renders against the latest published release (or the version
given to `workflow_dispatch`) and pushes nothing. `--online` downloads the DMG for the
runner's architecture and checks it against the cask's hash, so it renders with the real
DMG hashes and only skips the Windows installer download. It runs only when those paths
change, so a new rule on Homebrew's side still fails an unchanged template in the next
publish run first; dispatch it to check the latest release against current Homebrew.

Chocolatey has no target repo: `choco pack` builds the `.nupkg` from the rendered
`chocolatey/` tree and `choco push` uploads it directly to the community feed
(community.chocolatey.org). That means the Homebrew/Scoop re-run safety (a clean git
tree — nothing to commit, so the job no-ops) doesn't apply; instead the `chocolatey` job
looks up `Packages(Id='logtapper',Version='$VERSION')` on the community feed before packing
and skips the pack-and-push step only when that version is **approved**. That lookup also
returns versions still in moderation (`IsApproved=false`, `PackageStatus=Submitted`), and
those are pushed again on a re-run, which is how a fix goes up when a moderator asks for
changes. If Chocolatey refuses a push because the version already exists, the job treats that
409/"already exists" response as a no-op rather than a failure. Every version, including the first, is pushed
by that job — the `CHOCO_API_KEY` secret is the only place the key lives.

No push happens without an install test first. `.github/workflows/verify-chocolatey.yml`
renders and packs the package on a throwaway `windows-latest` runner and runs
`scripts/verify-chocolatey.ps1` against it: install location and Add/Remove Programs entry,
file associations, a reinstall over a running app, uninstall (including after the app was
removed by hand), and a tampered checksum aborting the install. It runs on every PR that
touches the package or the renderer, on demand (`workflow_dispatch`, defaulting to the latest
release), and as the `chocolatey-verify` job that `publish-packages.yml`'s push depends on.
The script installs machine-wide, so only run it by hand on a disposable machine.

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
