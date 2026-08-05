#!/bin/bash
# 0x0.st adapter - Free, no-signup file hosting
# https://0x0.st
#
# Usage: ./0x0st.sh <file>
# Output: URL to uploaded file (stdout)
#
# Notes:
#   - Files expire after 365 days (or sooner for larger files)
#   - Max file size: 512 MiB
#   - No authentication required

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

# Public-host guard: 0x0.st is an unauthenticated public file host (files
# retained ~365 days, URL accessible to anyone). Screenshots can contain
# sensitive data, so this adapter refuses to run without explicit opt-in.
if [[ "${PREPOST_ALLOW_PUBLIC_UPLOAD:-}" != "1" ]]; then
    echo "Error: 0x0.st is a PUBLIC, unauthenticated file host (files retained ~365 days)." >&2
    echo "Use GitHub storage instead (default git-native adapter, works on private repos)." >&2
    echo "If you have no GitHub account and the screenshots contain nothing sensitive," >&2
    echo "opt in explicitly with: PREPOST_ALLOW_PUBLIC_UPLOAD=1" >&2
    exit 1
fi

# Upload to 0x0.st - returns the URL directly
URL=$(curl -s -A "before-after-cli/1.0" -F "file=@$FILE" https://0x0.st)

# Validate we got a URL back
if [[ ! "$URL" =~ ^https?:// ]]; then
    echo "Error: Upload failed. Response: $URL" >&2
    exit 1
fi

echo "$URL"
