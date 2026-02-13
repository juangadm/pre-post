#!/bin/bash
# Git-native adapter - Stage a screenshot in .pre-post/ on the PR branch
#
# Usage: ./git-native.sh <file>
# Output: filename (stdout)
#
# Requirements:
#   - Inside a git repo
#
# Notes:
#   - Stages only the specific file, never `git add .`
#   - Does NOT commit or push — the caller (upload-and-copy.sh) batches that
#   - Returns filename only — URL is constructed by upload-and-copy.sh after
#     commit, using the SHA for blob URLs that work on public + private repos

set -e

FILE="$1"

if [[ -z "$FILE" ]]; then
    echo "Usage: $0 <file>" >&2
    exit 1
fi

if [[ ! -f "$FILE" ]]; then
    echo "Error: File not found: $FILE" >&2
    exit 1
fi

# Must be inside a git repo
if ! git rev-parse --is-inside-work-tree &>/dev/null; then
    echo "Error: Not inside a git repository" >&2
    exit 1
fi

# Copy file into .pre-post/ at the repo root
REPO_ROOT=$(git rev-parse --show-toplevel)
DEST_DIR="$REPO_ROOT/.pre-post"
mkdir -p "$DEST_DIR"

FILENAME=$(basename "$FILE")
DEST="$DEST_DIR/$FILENAME"
cp "$FILE" "$DEST"

# Stage only this specific file (-f to override .gitignore)
git add -f "$DEST"

echo "Staged: .pre-post/$FILENAME" >&2

# Return just the filename — URL built by caller after commit
echo "$FILENAME"
