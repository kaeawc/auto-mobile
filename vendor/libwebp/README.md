# Bundled libwebp tools

This directory vendors the WebP `cwebp` and `dwebp` command line tools for
Windows x64 so AutoMobile can preserve WebP screenshots offline on Windows.

- Version: libwebp 1.6.0
- Source archive: https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0-windows-x64.zip
- Upstream docs: https://developers.google.com/speed/webp/docs/precompiled
- License: see `COPYING` and `PATENTS`, copied from the matching
  `libwebp-1.6.0.tar.gz` source archive.

Only `win32-x64/cwebp.exe` and `win32-x64/dwebp.exe` are included. Other tools
from the upstream archive are intentionally omitted.
