# Services

- `www`: V2 usage documentation, API reference, search and generated schemas. The root redirects to docs.
- `files`: CLI artifact distribution; retained as runtime/release infrastructure.
- `update`: version and update API; retained as runtime/release infrastructure.

The standalone articles and changelog sites have been removed. V1 documentation remains in `packages/web`; website marketing routes have been removed from `packages/console/app` while documentation and API/share proxy routes remain.

GitHub Actions is paused; inherited workflows are archived under `.github/workflows-disabled`.
