#!/bin/bash
# upload-and-copy.sh - Upload images via pluggable storage adapters
# Usage: ./upload-and-copy.sh <before.png> <after.png> [--markdown]
#
# Options:
#   --markdown    Generate PR markdown table and copy to clipboard
#
# Environment:
#   IMAGE_ADAPTER    Storage adapter to use (default: git-native)
#                    Available: git-native, 0x0st, blob
#
# Adapter-specific environment variables:
#   blob:  BLOB_UPLOAD_URL - Custom upload endpoint
#
# Examples:
#   ./upload-and-copy.sh before.png after.png
#   ./upload-and-copy.sh before.png after.png --markdown
#   IMAGE_ADAPTER=0x0st ./upload-and-copy.sh before.png after.png --markdown

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Resolve owner/repo from env vars or git remote URL (supports proxy URLs)
resolve_owner_repo() {
    if [[ -n "${GH_REPO:-}" ]]; then echo "$GH_REPO"; return; fi
    if [[ -n "${GITHUB_REPOSITORY:-}" ]]; then echo "$GITHUB_REPOSITORY"; return; fi

    local url
    url=$(git remote get-url origin 2>/dev/null) || true

    # Standard GitHub HTTPS/SSH
    local std
    std=$(echo "$url" | sed -nE 's#.*github\.com[/:]([^/]+/[^/]+?)(\.git)?$#\1#p')
    if [[ -n "$std" ]]; then echo "$std"; return; fi

    # Proxy fallback: last two path segments
    local proxy
    proxy=$(echo "$url" | sed -nE 's#.*/([^/]+/[^/]+?)(\.git)?$#\1#p')
    if [[ -n "$proxy" ]]; then echo "$proxy"; return; fi

    echo "Error: Cannot parse owner/repo. Set GH_REPO=owner/repo" >&2
    exit 1
}

# Check if gh CLI is installed and authenticated
gh_is_authenticated() {
    command -v gh &>/dev/null && gh auth status &>/dev/null
}

# Copy text to system clipboard (macOS or Linux)
copy_to_clipboard() {
    local text="$1"
    local label="${2:-Text}"
    if command -v pbcopy &>/dev/null; then
        echo "$text" | pbcopy
        echo "$label copied to clipboard!"
    elif command -v xclip &>/dev/null; then
        echo "$text" | xclip -selection clipboard
        echo "$label copied to clipboard!"
    else
        echo "(clipboard copy not available - install pbcopy or xclip)"
    fi
}

ADAPTERS_DIR="$SCRIPT_DIR/adapters"

# Default adapter
IMAGE_ADAPTER="${IMAGE_ADAPTER:-git-native}"

BEFORE_FILE="$1"
AFTER_FILE="$2"
shift 2 2>/dev/null || true

MARKDOWN_MODE=false

# Parse options
while [[ $# -gt 0 ]]; do
    case $1 in
        --markdown)
            MARKDOWN_MODE=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Validate inputs
if [[ -z "$BEFORE_FILE" || -z "$AFTER_FILE" ]]; then
    echo "Usage: $0 <before.png> <after.png> [--markdown]"
    echo ""
    echo "Environment:"
    echo "  IMAGE_ADAPTER    Storage adapter (default: git-native)"
    echo "                   Available: git-native, 0x0st, blob"
    exit 1
fi

if [[ ! -f "$BEFORE_FILE" ]]; then
    echo "Error: Before file not found: $BEFORE_FILE"
    exit 1
fi

if [[ ! -f "$AFTER_FILE" ]]; then
    echo "Error: After file not found: $AFTER_FILE"
    exit 1
fi

# Validate adapter exists
ADAPTER_SCRIPT="$ADAPTERS_DIR/$IMAGE_ADAPTER.sh"
if [[ ! -f "$ADAPTER_SCRIPT" ]]; then
    echo "Error: Unknown adapter: $IMAGE_ADAPTER"
    echo ""
    echo "Available adapters:"
    for adapter in "$ADAPTERS_DIR"/*.sh; do
        name=$(basename "$adapter" .sh)
        echo "  - $name"
    done
    exit 1
fi

# Upload function using adapter
# NOTE: git-native adapter returns a filename (not a URL) — the URL is
# constructed below after commit+push, using the SHA for blob URLs.
upload_file() {
    local file="$1"
    local filename=$(basename "$file")

    echo "Uploading: $filename (via $IMAGE_ADAPTER)" >&2
    "$ADAPTER_SCRIPT" "$file"
}

# Upload both files (adapter returns filename for git-native, URL for others)
echo "=== Uploading Screenshots ==="
BEFORE_RESULT=$(upload_file "$BEFORE_FILE")
AFTER_RESULT=$(upload_file "$AFTER_FILE")

# For git-native: commit, push, then construct blob+SHA URLs.
# Blob URLs work for both public and private repos (same-origin on GitHub).
if [[ "$IMAGE_ADAPTER" == "git-native" ]]; then
    echo "Committing and pushing screenshots..." >&2
    git commit -m "chore: add pre/post screenshots"
    git push origin HEAD

    SHA=$(git rev-parse HEAD)
    if [[ ! "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
        echo "Error: Could not determine commit SHA after push (got: '$SHA')" >&2
        exit 1
    fi

    OWNER_REPO=$(resolve_owner_repo)

    BEFORE_URL="https://github.com/$OWNER_REPO/blob/$SHA/.pre-post/$BEFORE_RESULT?raw=true"
    AFTER_URL="https://github.com/$OWNER_REPO/blob/$SHA/.pre-post/$AFTER_RESULT?raw=true"
else
    # Other adapters (0x0st, blob) return full URLs directly
    BEFORE_URL="$BEFORE_RESULT"
    AFTER_URL="$AFTER_RESULT"
fi

echo ""
echo "Before URL: $BEFORE_URL"
echo "After URL: $AFTER_URL"
echo ""

if [[ "$MARKDOWN_MODE" != "true" ]]; then
    copy_to_clipboard "Before: $BEFORE_URL
After: $AFTER_URL" "URLs"
    exit 0
fi

# Build section with commit reference
SHORT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
TIMESTAMP=$(date "+%Y-%m-%d %H:%M")

SECTION="### Screenshots ($SHORT_SHA — $TIMESTAMP)

| Pre | Post |
|:---:|:----:|
| ![Pre]($BEFORE_URL) | ![Post]($AFTER_URL) |"

echo "=== PR Markdown ==="
echo "$SECTION"
echo ""

# Auto-append to PR body if gh CLI is available and authenticated
GH_REPO=$(resolve_owner_repo)
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)

if ! gh_is_authenticated || [[ -z "$GH_REPO" ]] || [[ -z "$CURRENT_BRANCH" ]]; then
    if command -v gh &>/dev/null && ! gh_is_authenticated; then
        echo "(gh CLI found but not authenticated — run 'gh auth login' to enable auto PR updates)"
    fi
    echo "Paste the markdown above into your PR description."
    copy_to_clipboard "$SECTION" "Markdown"
    exit 0
fi

PR_JSON=$(gh pr view "$CURRENT_BRANCH" --repo "$GH_REPO" --json number,body 2>/dev/null || true)

if [[ -z "$PR_JSON" ]]; then
    echo "(no PR found for branch '$CURRENT_BRANCH' — create a PR first, then paste the markdown above into the description)"
    copy_to_clipboard "$SECTION" "Markdown"
    exit 0
fi

PR_NUMBER=$(echo "$PR_JSON" | grep -o '"number":[0-9]*' | grep -o '[0-9]*')
PR_BODY=$(echo "$PR_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('body',''))" 2>/dev/null || echo "")

# Stack: newest on top, right after ## Visual Changes header
NEW_BODY=$(python3 -c "
import sys
body = sys.argv[1]
section = sys.argv[2]
marker = '## Visual Changes'
if marker in body:
    # Insert new section right after header, push older ones down
    parts = body.split(marker, 1)
    print(parts[0] + marker + '\n\n' + section + '\n\n---' + parts[1])
else:
    # First time
    print(body + '\n\n' + marker + '\n\n' + section)
" "$PR_BODY" "$SECTION")

gh pr edit "$PR_NUMBER" --repo "$GH_REPO" --body "$NEW_BODY"
echo "Screenshots appended to PR #$PR_NUMBER body"

copy_to_clipboard "$SECTION" "Markdown"
