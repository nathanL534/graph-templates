#!/usr/bin/env bash
# Runs the real graph.config.ts with a fake agent: a retry, a review that sends
# draft back, a human pause, approval, then execute and log to done.
set -uo pipefail
cd "$(dirname "$0")/.."
export GRAPH_AGENT_CMD="bash $PWD/examples/fake-agent.sh"
rm -rf runs/demo
graph run demo --input examples/demo/input.md; code=$?
[ $code -eq 3 ] || { echo "expected a pause for approval (exit 3), got $code"; exit 1; }
echo; echo "--- demo: approving as the human ---"; touch runs/demo/APPROVED; echo
graph run demo || exit 1
echo; graph status demo
