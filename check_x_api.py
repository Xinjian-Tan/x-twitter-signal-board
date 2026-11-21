#!/usr/bin/env python3
"""
Preflight check for the X API.

This script only reads a lightweight user lookup; it never writes data.js,
data/history.json, or any file. It prints rate-limit headers and clear
messages for 401 / 403 / 429 / network errors.

Usage:
  X_BEARER_TOKEN=... python3 scripts/check_x_api.py
  X_API_BASE=http://127.0.0.1:9876/2 X_BEARER_TOKEN=test python3 scripts/check_x_api.py

Optional env:
  X_API_BASE       default https://api.x.com/2
  X_CHECK_HANDLE   default SemiAnalysis_
  HTTPS_PROXY      urllib honors standard proxy env vars
"""

from __future__ import annotations

import json
import os
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

REQUEST_TIMEOUT = 20
RATE_HEADERS = (
    "x-rate-limit-limit",
    "x-rate-limit-remaining",
    "x-rate-limit-reset",
    "x-user-limit-24h",
)


def main() -> int:
    token = os.environ.get("X_BEARER_TOKEN", "").strip()
    base = os.environ.get("X_API_BASE", "https://api.x.com/2").rstrip("/")
    handle = os.environ.get("X_CHECK_HANDLE", "SemiAnalysis_").strip()

    if not token:
        print("[check] X_BEARER_TOKEN is not set; workflow will run in mock mode.")
        print("[check] Add the secret in GitHub Settings -> Secrets and variables -> Actions.")
        return 0

    url = f"{base}/users/by/username/{quote(handle)}?user.fields=id,name,username"
    request = Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "User-Agent": "Signal8/1.0",
            "Accept": "application/json",
        },
    )

    try:
        with urlopen(request, timeout=REQUEST_TIMEOUT) as response:
            payload = json.loads(response.read().decode("utf-8"))
            user = payload.get("data") or {}
            print(f"[check] OK: token accepted; resolved @{user.get('username', handle)} (id={user.get('id')})")
            for header in RATE_HEADERS:
                value = response.headers.get(header)
                if value is not None:
                    print(f"[check] {header}: {value}")
            return 0
    except HTTPError as exc:
        body = exc.read().decode("utf-8", "replace").strip()[:300]
        retry_after = exc.headers.get("Retry-After") if exc.headers else None
        if exc.code == 401:
            print("[check] FAIL HTTP 401: token invalid or expired. Rotate X_BEARER_TOKEN.")
        elif exc.code == 403:
            print("[check] FAIL HTTP 403: access denied, app permission missing, or quota/credits exhausted.")
            print("[check] Check your X API plan, app permissions, and monthly usage.")
        elif exc.code == 429:
            print("[check] FAIL HTTP 429: rate limited. Wait for the rate-limit window to reset.")
        elif exc.code >= 500:
            print("[check] FAIL HTTP 5xx: X API server error. Retry later.")
        else:
            print(f"[check] FAIL HTTP {exc.code}: request rejected. Check token, plan, and parameters.")
        if retry_after:
            print(f"[check] retry-after: {retry_after}s")
        if body:
            print(f"[check] body: {body}")
        return 1
    except URLError as exc:
        print(f"[check] FAIL network error: {exc.reason}")
        print("[check] This environment may need HTTPS_PROXY or a network with X access.")
        return 1
    except json.JSONDecodeError as exc:
        print(f"[check] FAIL invalid JSON from X API: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
