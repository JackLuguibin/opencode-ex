# GitHub Actions paused

All inherited workflows are archived here and are not discovered by GitHub Actions. Actions is also disabled in the repository settings.

To resume later, first adapt branches and runner labels for opencode-ex, remove obsolete desktop jobs and dependencies from release workflows, and configure ex-owned deployment destinations. Restore only the reviewed workflows to `.github/workflows/`, update Turbo's workflow input path if appropriate, then explicitly enable Actions in repository settings.

Do not restore the upstream deployment, publishing, or issue-triage automations wholesale.
