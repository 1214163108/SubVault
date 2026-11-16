"""Package the loadable extension into dist/subvault-<version>.zip."""

import hashlib
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
EXCLUDE_DIRS = {".github", ".tmp", ".tmp-e2e", ".tmp-host", "dist", "docs", "native-host", "tests", "tools", ".git", "node_modules", ".pnpm-store"}
EXCLUDE_FILES = {
    ".gitignore",
    "Dockerfile",
    "REVIEWER.md",
    "PRIVACY.md",
    "优化方案2026年11月12日.md",
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
        if any(part in EXCLUDE_DIRS or part.startswith(".tmp") for part in relative.parts):
            continue
        if relative.name in EXCLUDE_FILES:
            continue
        if len(relative.parts) == 1 and relative.suffix.lower() == ".md" and relative.name not in {"README.md", "SECURITY.md"}:
            continue
        if len(relative.parts) == 1 and relative.suffix.lower() in {".ps1", ".sh"}:
            continue
        files.append(relative)

    # Reproducible archive: fixed timestamps/permissions and stable ordering,
    # so two builds from the same source produce byte-identical zips.
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for relative in sorted(files, key=lambda item: item.as_posix()):
            info = zipfile.ZipInfo(relative.as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o644 << 16
            archive.writestr(info, (ROOT / relative).read_bytes(), compresslevel=9)

    print(f"wrote {target} ({target.stat().st_size:,} bytes, {len(files)} files)")
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    checksum = target.with_suffix(target.suffix + ".sha256")
    checksum.write_text(f"{digest}  {target.name}\n", encoding="utf-8")
    print(f"sha256 {digest}")
    for relative in sorted(files):
        print(f"  {relative.as_posix()}")


if __name__ == "__main__":
    main()
