#!/usr/bin/env bash
# Stand-in for an LLM so the demo runs offline and deterministically.
# The runner sets GRAPH_ROOT / GRAPH_KEY / GRAPH_STEP / GRAPH_ATTEMPT / GRAPH_VERDICT; the prompt ($1) is ignored.
# It fails on purpose twice to show the loop: draft's first attempt has an
# unsourced claim (retry), and the first review FAILs (draft re-runs with feedback).
set -euo pipefail
demo="$GRAPH_ROOT/examples/demo"
case "$GRAPH_STEP" in
  intake)   cp "$demo/request.md" . ;;
  research) cp "$demo/research.md" . ;;
  setup)    : > no-setup-needed.flag ;;
  draft)
    cp "$demo/draft.md" .
    if [ "$GRAPH_ATTEMPT" = 1 ] && ! grep -q "Sent back by" "$GRAPH_FEEDBACK"; then
      echo '{"claims":[{"text":"Bun is the fastest runtime"}]}' > claims.json
    else
      cp "$demo/claims.json" .
    fi ;;
  review)
    if [ ! -f .graph/demo-reviewed-once ]; then
      touch .graph/demo-reviewed-once
      printf 'draft.md does not say who the summary is for.\nVerdict: FAIL\n' > "$GRAPH_VERDICT"
    else
      printf 'All claims supported; every sentence is in the ledger; done-conditions met.\nVerdict: PASS\n' > "$GRAPH_VERDICT"
    fi ;;
  execute)  cp "$demo/replay.sh" "$demo/readback.json" . && bash replay.sh ;;
  log)
    # Upsert this run's row in the local tracker, then read it back.
    tracker="$GRAPH_ROOT/tracker.jsonl"
    row="{\"key\":\"$GRAPH_KEY\",\"status\":\"EXECUTED\",\"target\":\"target/README-section.md\"}"
    touch "$tracker"
    { grep -v "\"key\":\"$GRAPH_KEY\"" "$tracker" || true; echo "$row"; } > "$tracker.tmp" && mv "$tracker.tmp" "$tracker"
    readBack=$(grep "\"key\":\"$GRAPH_KEY\"" "$tracker")
    printf '{ "written": %s, "readBack": %s }\n' "$row" "$readBack" > log.json ;;
  *) echo "fake-agent: unknown step $GRAPH_STEP" >&2; exit 1 ;;
esac
