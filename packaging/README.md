# Packaging templates

`homebrew/logtapper.rb.tmpl` and `scoop/logtapper.json.tmpl` are the Homebrew cask and
Scoop manifest for LogTapper, kept here as the single source of truth and rendered by
`scripts/render-packaging.mjs` for each release. `.github/workflows/publish-packages.yml`
runs the renderer on every published release and pushes the rendered files to the two
publish-target repos (`jpicklyk/homebrew-logtapper` as `Casks/logtapper.rb`,
`jpicklyk/logtapper-scoop` as `bucket/logtapper.json`) — this repo never ships those files
directly, and neither target repo carries anything else. Both target repos must exist
with at least one commit (create them with a README) before the workflow runs —
`actions/checkout` cannot clone an empty repository; the `Casks/` and `bucket/`
directories are created on first push.

To render locally against a real release:

```bash
node scripts/render-packaging.mjs --version 0.14.0 --out /tmp/packaging-out
```

This downloads the three release assets and hashes them; pass `--sha256
<asset-basename>=<hex>` (repeatable) to skip the download for a given asset, e.g. in tests
or offline. `node scripts/render-packaging.mjs --check` renders the committed templates
against the current `package.json` version with dummy hashes and fails if any `{{...}}`
placeholder survives — run it whenever a template changes. Script tests live in
`scripts/render-packaging.test.mjs`, run with `npm run test:scripts` (`node --test`, not
part of `npm test`, which is the Solid/vitest suite).
