"""Build a source-only distribution and reject local secret values before delivery."""

import hashlib
import os
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "youtubedown_Website_Support_Updated.zip"
DIRECTORIES = {
    "backend",
    "frontend",
    "docs",
    "egress",
    "scripts",
    "supabase",
    "verification",
}
EXCLUDED = {
    ".git",
    ".agents",
    ".codex",
    ".aws",
    "node_modules",
    ".venv",
    "venv",
    "env",
    "__pycache__",
    ".pytest_cache",
    ".ruff_cache",
    ".mypy_cache",
    "dist",
    "build",
    "coverage",
    ".cache",
    "test-results",
    "playwright-report",
}
MEDIA = {
    ".mp4",
    ".mp3",
    ".mkv",
    ".webm",
    ".wav",
    ".m4a",
    ".aac",
    ".ogg",
    ".opus",
    ".mov",
    ".part",
    ".ytdl",
}
ROOT_FILES = {
    ".dockerignore",
    ".gitignore",
    ".env.production.example",
    "Caddyfile",
    "Caddyfile.local",
    "netlify.toml",
    "README.md",
    "START_HERE.md",
}


def excluded(path):
    return (
        any(part in EXCLUDED for part in path.parts)
        or (path.name.startswith(".env") and not path.name.endswith(".example"))
        or path.suffix.lower()
        in MEDIA
        | {".zip", ".pyc", ".pyo", ".tsbuildinfo", ".log", ".pem", ".key", ".pfx"}
        or path.name in {"diagnostics.txt", ".DS_Store"}
    )


def local_secrets():
    values = []
    for env_path in [
        ROOT / "backend/.env",
        ROOT / "frontend/.env.local",
        ROOT / ".env.production",
    ]:
        if not env_path.exists():
            continue
        for line in env_path.read_text(encoding="utf-8-sig").splitlines():
            name, sep, value = line.partition("=")
            value = value.strip().strip("\"'")
            if (
                sep
                and len(value) >= 16
                and any(
                    word in name.upper()
                    for word in (
                        "SECRET",
                        "PASSWORD",
                        "PRIVATE",
                        "TOKEN",
                        "SERVICE_ROLE",
                    )
                )
            ):
                values.append(value.encode())
    return values


def package():
    candidates = []
    for path in ROOT.iterdir():
        if path.is_file() and (
            path.name in ROOT_FILES
            or path.suffix == ".bat"
            or path.name.startswith("docker-compose")
            and path.suffix == ".yml"
        ):
            candidates.append(path)
    for directory in sorted(DIRECTORIES):
        for current, dirs, files in os.walk(ROOT / directory):
            dirs[:] = [name for name in dirs if name not in EXCLUDED]
            for name in files:
                path = Path(current) / name
                if not excluded(path.relative_to(ROOT)) and not path.is_symlink():
                    candidates.append(path)
    secrets = local_secrets()
    for path in candidates:
        data = path.read_bytes()
        if any(value in data for value in secrets):
            raise RuntimeError(
                "Local secret value found in distribution candidate: "
                + str(path.relative_to(ROOT))
            )
    with ZipFile(OUTPUT, "w", ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(candidates):
            archive.write(path, "youtubedown/" + path.relative_to(ROOT).as_posix())
    with ZipFile(OUTPUT) as archive:
        assert archive.testzip() is None
        names = archive.namelist()
        assert not any(
            excluded(Path(name).relative_to("youtubedown")) for name in names
        )
        for required in [
            "frontend/src/lib.ts",
            "frontend/src/autoDownload.ts",
            "frontend/src/main.tsx",
            "frontend/package-lock.json",
            "backend/requirements.txt",
            "backend/requirements-dev.txt",
            "netlify.toml",
            "docs/WEBSITE_SUPPORT_SETUP.md",
            "docs/WEBSITE_SUPPORT_VERIFICATION.md",
        ]:
            assert "youtubedown/" + required in names
    print(
        f"Created {OUTPUT.name}: {len(candidates)} source files, {OUTPUT.stat().st_size} bytes"
    )
    print("SHA256 " + hashlib.sha256(OUTPUT.read_bytes()).hexdigest())


if __name__ == "__main__":
    package()
