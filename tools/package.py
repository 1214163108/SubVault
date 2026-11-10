"""Package the loadable extension into dist/subvault-<version>.zip."""

import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
EXCLUDE_DIRS = {".tmp", ".tmp-e2e", ".tmp-host", "dist", "docs", "native-host", "tests", "tools", ".git", "node_modules", ".pnpm-store"}
EXCLUDE_FILES = {
    "package.json",
    "package-lock.json",
    "playwright.config.js",
    "pnpm-lock.yaml",
    "psl.dat",
    "README.md.txt",
}


def main() -> None:
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    DIST.mkdir(exist_ok=True)
    target = DIST / f"subvault-{version}.zip"

    files = []
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(ROOT)
        if any(part in EXCLUDE_DIRS for part in relative.parts):
            continue
        if relative.name in EXCLUDE_FILES:
            continue
        files.append(relative)

    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for relative in sorted(files):
            archive.write(ROOT / relative, relative.as_posix())

    print(f"wrote {target} ({target.stat().st_size:,} bytes, {len(files)} files)")
    for relative in sorted(files):
        print(f"  {relative.as_posix()}")


if __name__ == "__main__":
    main()
