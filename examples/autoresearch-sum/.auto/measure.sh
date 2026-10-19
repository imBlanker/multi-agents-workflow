#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
node benchmark.mjs
