# Reproducible extension build.
#
#   docker build -t subvault-build .
#   docker run --rm -v "$PWD/dist:/out" subvault-build
#
# The archive is deterministic: fixed entry timestamps/permissions, sorted
# paths and fixed compression level, so the same source always yields the same
# SHA-256. No network access is needed during the build.
FROM python:3.12-slim

WORKDIR /src
COPY . /src
RUN python tools/package.py

CMD ["sh", "-c", "cp /src/dist/subvault-*.zip /src/dist/*.sha256 /out/"]
