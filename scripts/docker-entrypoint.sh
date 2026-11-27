#!/bin/sh
# Container entrypoint for the app and jobs-worker images: hands off to
# dumb-init so signals are forwarded to the process. Every command runs
# through here — the default CMD and a compose `command:` alike.
set -e
exec dumb-init -- "$@"
