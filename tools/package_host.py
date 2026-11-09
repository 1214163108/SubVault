from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parent.parent
HOST = ROOT / "native-host"
OUT = ROOT / "dist" / "subvault-sync-host-1.0.0.zip"
FILES = [
    "SubVaultSync.exe",
    "install-host.ps1",
    "uninstall-host.ps1",
    "README.txt",
    "extension-id.txt",
]


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(OUT, "w", ZIP_DEFLATED) as archive:
        for name in FILES:
            path = HOST / name
            if not path.exists():
                raise SystemExit(f"missing host file: {path}")
            archive.write(path, arcname=name)
    print(f"wrote {OUT} ({OUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
