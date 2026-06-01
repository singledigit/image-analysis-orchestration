#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# CVPR 2026 — booth demo: submit an image and watch the durable pipeline run
#
# Usage:
#   ./demo/invoke.sh <path-to-image.jpg>
#   ./demo/invoke.sh ./demo/sample.jpg
#
# What to narrate while this runs:
#   1. We submit an image — the pipeline checkpoints every step automatically.
#   2. Step 1 (preprocess) fires: divides image into a 3×3 grid of 9 regions.
#   3. Step 2 (analyze-regions): context.map() fans out 9 CONCURRENT Lambda
#      invocations — each region analyzed independently by Bedrock Nova.
#      If you kill Lambda mid-map, only the failed regions retry.
#   4. Step 3 (synthesize): aggregates all region findings into one coherent
#      scene description with CV-specific insights.
#   5. Step 4 (store): checkpoints the final result.
#
# Kill-and-resume demo:
#   Run this in one terminal, then in another terminal run:
#     aws lambda put-function-concurrency --function-name cvpr-image-analysis-pipeline --reserved-concurrent-executions 0
#   Watch the execution pause. Then restore:
#     aws lambda delete-function-concurrency --function-name cvpr-image-analysis-pipeline
#   The pipeline resumes exactly where it stopped.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

IMAGE_PATH="${1:-./demo/sample.jpg}"
ALIAS_ARN="${ALIAS_ARN:-}"   # set this or let the script discover it

if [[ ! -f "$IMAGE_PATH" ]]; then
  echo "ERROR: image file not found: $IMAGE_PATH"
  exit 1
fi

# ── Discover alias ARN if not provided ───────────────────────────────────────
if [[ -z "$ALIAS_ARN" ]]; then
  ALIAS_ARN=$(aws cloudformation describe-stacks \
    --stack-name cvpr-image-analysis-demo \
    --query "Stacks[0].Outputs[?OutputKey=='AliasArn'].OutputValue" \
    --output text 2>/dev/null || true)
fi

if [[ -z "$ALIAS_ARN" ]]; then
  # Fall back to $LATEST for local testing
  ALIAS_ARN="cvpr-image-analysis-pipeline:\$LATEST"
  echo "Stack not deployed — using \$LATEST (deploy first for full demo)"
fi

# ── Build payload ─────────────────────────────────────────────────────────────
IMAGE_ID="cvpr-demo-$(date +%s)"
IMAGE_B64=$(base64 < "$IMAGE_PATH" | tr -d '\n')
MEDIA_TYPE="image/jpeg"
[[ "$IMAGE_PATH" == *.png ]] && MEDIA_TYPE="image/png"

PAYLOAD=$(cat <<JSON
{
  "imageId": "${IMAGE_ID}",
  "imageBase64": "${IMAGE_B64}",
  "imageMediaType": "${MEDIA_TYPE}",
  "gridSize": 3
}
JSON
)

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  CVPR 2026 — Durable Image Analysis Pipeline"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Image:    $IMAGE_PATH"
echo "  Image ID: $IMAGE_ID"
echo "  Function: $ALIAS_ARN"
echo "  Grid:     3×3 = 9 regions → 9 concurrent Bedrock calls"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

TMPOUT=$(mktemp /tmp/cvpr-response-XXXX.json)

aws lambda invoke \
  --function-name "$ALIAS_ARN" \
  --invocation-type RequestResponse \
  --payload "$PAYLOAD" \
  --cli-binary-format raw-in-base64-out \
  --output json \
  "$TMPOUT" \
  | jq -r '"Status: \(.StatusCode)"'

echo ""
echo "── Result ───────────────────────────────────────────────"
if command -v jq &>/dev/null; then
  jq '{
    imageId: .imageId,
    regions: .regionCount,
    successful: .successfulRegions,
    sceneType: .synthesis.sceneType,
    description: .synthesis.overallDescription,
    cvInsights: .synthesis.cvInsights,
    storedAt: .storedAt
  }' "$TMPOUT"
else
  cat "$TMPOUT"
fi

rm -f "$TMPOUT"
