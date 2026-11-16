from pathlib import Path
import hashlib
import zipfile
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parent.parent
HOST = ROOT / "native-host"
BIN = ROOT / "dist" / "native-host"
OUT = ROOT / "dist" / "subvault-sync-host-1.5.1.zip"

# (archive name, source path, executable)
FILES = [
    ("SubVaultSync.exe", HOST / "SubVaultSync.exe", False),
    ("subvault-sync-windows-amd64.exe", BIN / "subvault-sync-windows-amd64.exe", False),
    ("subvault-sync-linux-amd64", BIN / "subvault-sync-linux-amd64", True),
    ("subvault-sync-linux-arm64", BIN / "subvault-sync-linux-arm64", True),
    ("subvault-sync-darwin-amd64", BIN / "subvault-sync-darwin-amd64", True),
    ("subvault-sync-darwin-arm64", BIN / "subvault-sync-darwin-arm64", True),
    ("install-host.ps1", HOST / "install-host.ps1", False),
    ("uninstall-host.ps1", HOST / "uninstall-host.ps1", False),
    ("install-host.sh", HOST / "install-host.sh", True),
    ("uninstall-host.sh", HOST / "uninstall-host.sh", True),
    ("build-host.sh", HOST / "build-host.sh", True),
    ("README.txt", HOST / "README.txt", False),
    ("extension-id.txt", HOST / "extension-id.txt", False),
    ("go/main.go", HOST / "go" / "main.go", False),
    ("go/go.mod", HOST / "go" / "go.mod", False),
]


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(OUT, "w", ZIP_DEFLATED, compresslevel=9) as archive:
        for name, path, executable in sorted(FILES):
            if not path.exists():
                raise SystemExit(f"missing host file: {path}")
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = (0o755 if executable else 0o644) << 16
            archive.writestr(info, path.read_bytes(), compresslevel=9)
    print(f"wrote {OUT} ({OUT.stat().st_size:,} bytes)")
    digest = hashlib.sha256(OUT.read_bytes()).hexdigest()
    checksum = OUT.with_suffix(OUT.suffix + ".sha256")
    checksum.write_text(f"{digest}  {OUT.name}\n", encoding="utf-8")
    print(f"sha256 {digest}")


if __name__ == "__main__":
    main()
