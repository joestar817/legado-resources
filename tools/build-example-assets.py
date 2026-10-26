"""Build the original PNG and NG theme examples with Python's standard library."""
from pathlib import Path
import json
import struct
import zlib
import zipfile

ROOT = Path(__file__).resolve().parent.parent


def png_chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def color(hex_rgb):
    return int("ff" + hex_rgb, 16) - 2**32


def color_set(primary, secondary, text, muted, background, label):
    return dict(zip(
        ("primary", "secondary", "primaryText", "secondaryText", "background", "labelContainer"),
        map(color, (primary, secondary, text, muted, background, label)),
    ))


def build():
    background = ROOT / "resources/backgrounds/warm-paper-example"
    theme = ROOT / "resources/themes/warm-paper-example"
    background.mkdir(parents=True, exist_ok=True)
    theme.mkdir(parents=True, exist_ok=True)
    width, height = 1080, 1440
    rows = bytearray()
    for y in range(height):
        rows.append(0)
        for x in range(width):
            shade = 2 if (x * 17 + y * 31) % 29 == 0 else 0
            rows.extend((246 - shade, 240 - shade, 226 - shade))
    png = b"\x89PNG\r\n\x1a\n"
    png += png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    png += png_chunk(b"IDAT", zlib.compress(rows, 9)) + png_chunk(b"IEND", b"")
    (background / "warm-paper.png").write_bytes(png)

    manifest = {
        "format": "reading-ng-theme", "version": 1,
        "theme": {
            "schemaVersion": 1, "id": "example.warm-paper", "name": "暖纸示例",
            "colors": {
                "mode": "MANUAL", "lightSeed": color("735B36"), "darkSeed": color("DDC49A"),
                "paletteStyle": "TONAL_SPOT", "contrast": "DEFAULT", "colorSpec": "MATERIAL_3_2021",
                "manualLight": color_set("735B36", "84745D", "28241E", "726B61", "F8F4E9", "EDE3CF"),
                "manualDark": color_set("DDC49A", "C8B89F", "EEE8DC", "C7BFB2", "211E19", "3A3227"),
                "lightTopBarTextMode": "AUTO", "darkTopBarTextMode": "AUTO",
            },
            "lightBackground": {"path": None, "blur": 0},
            "darkBackground": {"path": None, "blur": 0},
            "transparentAppBars": True, "barProfile": None, "packageRootPath": None,
            "resourceProfile": None, "coverProfile": None, "ownedCoverAlbumIds": None,
            "sceneProfile": None, "drawerProfile": None,
        },
        "lightBackgroundAsset": None, "darkBackgroundAsset": None,
        "lightDrawerImageAsset": None, "darkDrawerImageAsset": None,
    }
    payload = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    (theme / "manifest.json").write_bytes(payload)
    info = zipfile.ZipInfo("manifest.json", (2026, 10, 26, 0, 0, 0))
    info.compress_type = zipfile.ZIP_STORED
    info.external_attr = 0o100644 << 16
    with zipfile.ZipFile(theme / "warm-paper.ngtheme", "w") as archive:
        archive.writestr(info, payload)


if __name__ == "__main__":
    build()
