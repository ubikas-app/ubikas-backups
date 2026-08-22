# ubikas-backups

Daily encrypted backups of the Ubikas database to Cloudflare R2.

## The one rule

This repository is public so that Actions runs on the free standard-runner allowance.
That is only safe while one thing stays true:

**No workflow that reads a secret may be triggered by a pull request.**

GitHub never passes secrets to a workflow triggered by a fork's pull request, so
`backup.yml` and `freshness.yml` carry `schedule` and `workflow_dispatch` and nothing
else. Never add `pull_request`, `pull_request_target`, `workflow_run`, or
`issue_comment` to either of them.

`test.yml` does use `pull_request`. That is safe because it reads no secrets and needs
none. Keep it that way.

Nothing sensitive belongs in this tree. Configuration arrives as repository secrets and
variables.

## Development

```bash
npm test
```

The script takes `--dry-run`, which dumps and encrypts but does not upload, and needs no
R2 credentials.

## Operations

Setup, restore, retention, and troubleshooting are documented in the private application
repository.
