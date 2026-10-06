#!/bin/zsh
cd -- "${0:A:h}"
exec node --env-file-if-exists=.env scripts/claude.mjs "$@"
