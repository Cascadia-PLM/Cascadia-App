# CLA signatures

This orphan branch is storage for the CLA Assistant bot configured in
[`.github/workflows/cla.yml`](https://github.com/Cascadia-PLM/Cascadia-App/blob/main/.github/workflows/cla.yml)
on `main`. The bot writes and updates `signatures/version1/cla.json` here as
contributors sign the [CLA](https://github.com/Cascadia-PLM/Cascadia-App/blob/main/CLA.md)
by commenting on their pull request.

It carries no project code and shares no history with `main` — nothing here is
part of a release.

Two things to leave alone:

- **Do not protect this branch.** The bot commits to it directly; branch
  protection makes every signature fail to record.
- **Do not delete it.** The bot does not create the branch itself. Without it
  every CLA check fails with `Branch cla-signatures not found`, no matter what
  the contributor does — which is exactly what happened before this branch
  existed.
