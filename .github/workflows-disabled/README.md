# GitHub Actions paused

Retained check and deployment workflow references are archived here and are not discovered by GitHub Actions. Actions is also disabled in repository settings.

Upstream release, signing and issue/PR triage scripts and their workflows have been removed. They remain recoverable from Git history. Local build/pack commands and pre-push checks are retained.

To resume, review branches, runner labels, ex-owned resource bindings and secrets. Restore only the reviewed workflows to `.github/workflows/`, adjust Turbo workflow inputs if needed, then explicitly enable Actions in repository settings.
