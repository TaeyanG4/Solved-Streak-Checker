"""Chrome 웹 스토어 업로드용 zip을 만든다.

확장 프로그램 실행에 필요한 파일만 담는다(테스트, README 이미지, package.json 등 제외).

사용법:
    python -I scripts/package.py            # dist/solved-streak-checker-<version>.zip
"""

from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parents[1]
INCLUDE = [
    "manifest.json",
    "background.js",
    "content.js",
    "popup.html",
    "popup.css",
    "popup.js",
    "lib/core.js",
    "lib/api.js",
    "images/icon16.png",
    "images/icon48.png",
    "images/icon128.png",
    "LICENSE",
]


def main() -> int:
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    missing = [f for f in INCLUDE if not (ROOT / f).is_file()]
    if missing:
        print(f"빠진 파일: {missing}", file=sys.stderr)
        return 1

    out_dir = ROOT / "dist"
    out_dir.mkdir(exist_ok=True)
    out = out_dir / f"solved-streak-checker-{version}.zip"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel in INCLUDE:
            zf.write(ROOT / rel, rel)
    print(f"생성: {out.relative_to(ROOT)} ({out.stat().st_size:,} bytes, {len(INCLUDE)}개 파일)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
