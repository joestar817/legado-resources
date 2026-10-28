#!/usr/bin/env python3
"""Render source-only thumbnails and controlled mixed-font detail samples."""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import sys
import unicodedata

from fontTools.pens.boundsPen import BoundsPen
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont, features

RENDERER_VERSION = "font-name-thumbnail-v3"
MAX_FONT_BYTES = 64 * 1024 * 1024
MAX_PNG_BYTES = 1024 * 1024
THUMBNAIL_SIZE = (256, 256)
DETAIL_SIZE = (960, 420)
SAMPLE_CANDIDATES = (
    "天地玄黄宇宙洪荒", "山川异域风月同天", "读书明理学以致用",
    "春夏秋冬山水人间", "阅读让世界更精彩",
    "TheQuickBrownFox", "Reading", "HelloWorld", "AaBbCcDd", "READING",
    "こんにちは", "안녕하세요", "Καλημέρα", "Приветмир", "مرحبا", "नमस्ते",
)
DIGITS = "0123456789"
DETAIL_SAMPLES = ("中国智造，慧及全球", "Innovation in China", "0123456789.:;'\"(!?)+-*/=")
FALLBACK_PATH = Path(__file__).resolve().parent / "fonts/preview-fallback.ttf"
FALLBACK_SHA256 = "16e044c9870f9e77dbff0aff69ba77e689c26902630822eaade8774d3bfb5c94"


class PreviewError(ValueError):
    pass


def _sfnt(data: bytes) -> None:
    if data[:4] not in (b"\x00\x01\x00\x00", b"OTTO"):
        raise PreviewError("Only uncompressed TrueType/OpenType SFNT fonts are supported")


def _no_links(path: Path) -> None:
    if not path.is_absolute():
        raise PreviewError("Paths must be absolute")
    current = Path(path.anchor)
    for part in path.parts[1:]:
        if part in (".", ".."):
            raise PreviewError("Paths must not contain traversal components")
        current /= part
        if current.is_symlink():
            raise PreviewError("Symbolic links are not allowed")


def read_font(path: Path) -> bytes:
    _no_links(path)
    if path.suffix.lower() not in (".ttf", ".otf"):
        raise PreviewError("Only TTF and OTF source fonts are supported")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    with os.fdopen(os.open(path, flags), "rb") as source:
        before = os.fstat(source.fileno())
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= MAX_FONT_BYTES:
            raise PreviewError("Font must be a non-empty regular file of at most 64 MiB")
        data = source.read(MAX_FONT_BYTES + 1)
        after = os.fstat(source.fileno())
    if len(data) != before.st_size or before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns:
        raise PreviewError("Font changed while it was being read")
    _sfnt(data)
    return data


@dataclass(frozen=True)
class Sample:
    text: str
    isolated: bool = False


@dataclass(frozen=True)
class FontRun:
    text: str
    source: bool


class Coverage:
    def __init__(self, font: TTFont):
        self.cmap = font.getBestCmap() or {}
        self.glyphs = font.getGlyphSet()
        self.results: dict[str, bool] = {}

    def has(self, character: str) -> bool:
        if character not in self.results:
            glyph_name = self.cmap.get(ord(character))
            supported = False
            if glyph_name and glyph_name != ".notdef":
                pen = BoundsPen(self.glyphs)
                self.glyphs[glyph_name].draw(pen)
                if pen.bounds:
                    left, top, right, bottom = pen.bounds
                    supported = right > left and bottom > top
            self.results[character] = supported
        return self.results[character]

    def contains(self, text: str) -> bool:
        return bool(text) and all(self.has(character) for character in text)

    def supports_sample_character(self, character: str) -> bool:
        if character == " ":
            # A real space needs a mapping and advance, not a visible outline.
            name = self.cmap.get(ord(character))
            return bool(name and name != ".notdef" and self.glyphs[name].width > 0)
        return self.has(character)

    def visible_characters(self, limit: int = 8) -> str:
        result = []
        for codepoint in sorted(self.cmap):
            if not 0 <= codepoint <= 0x10FFFF:
                continue
            character = chr(codepoint)
            # Standalone marks, separators and controls are unsuitable sample cells.
            if unicodedata.category(character)[0] not in "LNPS":
                continue
            if self.has(character):
                result.append(character)
                if len(result) == limit:
                    break
        return "".join(result)


def choose_samples(coverage: Coverage, font_name: str = "") -> tuple[Sample, Sample, Sample]:
    phrase = next((text for text in SAMPLE_CANDIDATES if coverage.contains(text)), None)
    if phrase is not None:
        primary = Sample(phrase)
    else:
        characters = coverage.visible_characters()
        if not characters:
            raise PreviewError("Font has no supported visible Unicode sample characters")
        # A gallery of separate source glyphs is not presented as an invented sentence.
        primary = Sample(characters, isolated=True)
    digits = "".join(character for character in DIGITS if coverage.has(character))
    number_sample = Sample(digits) if digits else primary
    thumb_characters = "".join(character for character in primary.text
                               if unicodedata.category(character)[0] in "LNPS")[:2]
    name_characters = "".join(character for character in unicodedata.normalize("NFC", font_name)
                              if unicodedata.category(character)[0] in "LNPS")[:2]
    if name_characters and coverage.contains(name_characters):
        thumb_characters = name_characters
    if not thumb_characters:
        thumb_characters = coverage.visible_characters(2)
    return primary, number_sample, Sample(thumb_characters, isolated=True)


def choose_runs(text: str, coverage: Coverage) -> tuple[FontRun, ...]:
    runs: list[FontRun] = []
    for character in text:
        source = coverage.supports_sample_character(character)
        if runs and runs[-1].source == source:
            runs[-1] = FontRun(runs[-1].text + character, source)
        else:
            runs.append(FontRun(character, source))
    return tuple(runs)


def read_fallback() -> bytes:
    try:
        data = read_font(FALLBACK_PATH)
        if hashlib.sha256(data).hexdigest() != FALLBACK_SHA256:
            raise PreviewError("Bundled preview fallback checksum mismatch")
        with TTFont(io.BytesIO(data), checkChecksums=2, lazy=False) as font:
            coverage = Coverage(font)
            if not all(coverage.supports_sample_character(character)
                       for text in DETAIL_SAMPLES for character in text):
                raise PreviewError("Bundled preview fallback does not cover the fixed samples")
        return data
    except Exception as error:
        raise PreviewError(f"Bundled preview fallback is invalid: {error}") from error


def _measure(draw: ImageDraw.ImageDraw, sample: Sample, font: ImageFont.FreeTypeFont):
    if sample.isolated:
        boxes = [draw.textbbox((0, 0), character, font=font) for character in sample.text]
        gap = max(4, font.size // 5)
        width = sum(box[2] - box[0] for box in boxes) + gap * (len(boxes) - 1)
        height = max(box[3] - box[1] for box in boxes)
        return width, height, boxes, gap
    box = draw.textbbox((0, 0), sample.text, font=font)
    return box[2] - box[0], box[3] - box[1], [box], 0


def draw_sample(image: Image.Image, data: bytes, sample: Sample,
                area: tuple[int, int, int, int], maximum_size: int) -> None:
    draw = ImageDraw.Draw(image)
    left, top, right, bottom = area
    for size in range(maximum_size, 3, -1):
        font = ImageFont.truetype(io.BytesIO(data), size, layout_engine=ImageFont.Layout.RAQM)
        width, height, boxes, gap = _measure(draw, sample, font)
        if 0 < width <= right - left and 0 < height <= bottom - top:
            break
    else:
        raise PreviewError("Visible font samples cannot fit within the preview bounds")
    x = left + (right - left - width) // 2
    if sample.isolated:
        for character, box in zip(sample.text, boxes):
            y = top + (bottom - top - (box[3] - box[1])) // 2
            draw.text((x - box[0], y - box[1]), character, font=font, fill=(0, 0, 0, 255))
            x += box[2] - box[0] + gap
    else:
        box = boxes[0]
        y = top + (bottom - top - height) // 2
        draw.text((x - box[0], y - box[1]), sample.text, font=font, fill=(0, 0, 0, 255))


def _run_metrics(runs: tuple[FontRun, ...], fonts: dict[bool, ImageFont.FreeTypeFont]):
    x = 0.0
    positions = []
    ink = []
    for run in runs:
        font = fonts[run.source]
        positions.append(x)
        left, top, right, bottom = font.getbbox(run.text, anchor="ls")
        if right > left and bottom > top:
            ink.append((x + left, top, x + right, bottom))
        x += font.getlength(run.text)
    if not ink:
        raise PreviewError("Mixed sample has no visible glyphs")
    return (min(box[0] for box in ink), min(box[1] for box in ink),
            max(box[2] for box in ink), max(box[3] for box in ink)), positions


def draw_mixed_sample(image: Image.Image, data: bytes, fallback: bytes | None,
                      runs: tuple[FontRun, ...], area: tuple[int, int, int, int],
                      maximum_size: int) -> None:
    draw = ImageDraw.Draw(image)
    left, top, right, bottom = area
    for size in range(maximum_size, 3, -1):
        fonts = {True: ImageFont.truetype(io.BytesIO(data), size, layout_engine=ImageFont.Layout.RAQM)}
        if any(not run.source for run in runs):
            if fallback is None:
                raise PreviewError("Mixed sample requires the bundled preview fallback")
            fonts[False] = ImageFont.truetype(io.BytesIO(fallback), size, layout_engine=ImageFont.Layout.RAQM)
        box, positions = _run_metrics(runs, fonts)
        width, height = box[2] - box[0], box[3] - box[1]
        if 0 < width <= right - left and 0 < height <= bottom - top:
            break
    else:
        raise PreviewError("Mixed font samples cannot fit within the preview bounds")
    x = left + (right - left - width) / 2 - box[0]
    baseline = top + (bottom - top - height) / 2 - box[1]
    for run, offset in zip(runs, positions):
        draw.text((x + offset, baseline), run.text, font=fonts[run.source],
                  anchor="ls", fill=(0, 0, 0, 255))


def _png(image: Image.Image) -> bytes:
    bounds = image.getchannel("A").getbbox()
    if not bounds or bounds[0] <= 0 or bounds[1] <= 0 or bounds[2] >= image.width or bounds[3] >= image.height:
        raise PreviewError("Preview glyphs are empty or touch the image boundary")
    output = io.BytesIO()
    image.save(output, format="PNG", optimize=True, compress_level=9)
    data = output.getvalue()
    if len(data) > MAX_PNG_BYTES:
        raise PreviewError("Preview exceeds the 1 MiB output limit")
    return data


def render(data: bytes, font_name: str = "") -> dict[str, tuple[bytes, tuple[int, int]]]:
    if not 0 < len(data) <= MAX_FONT_BYTES:
        raise PreviewError("Font must contain at most 64 MiB")
    _sfnt(data)
    if not features.check_feature("raqm"):
        raise PreviewError("The pinned preview renderer requires Pillow with RAQM")
    with TTFont(io.BytesIO(data), checkChecksums=2, lazy=False) as font:
        coverage = Coverage(font)
        _, _, thumbnail_sample = choose_samples(coverage, font_name)
        detail_runs = tuple(choose_runs(text, coverage) for text in DETAIL_SAMPLES)
    fallback = read_fallback() if any(not run.source for runs in detail_runs for run in runs) else None
    thumbnail = Image.new("RGBA", THUMBNAIL_SIZE, (0, 0, 0, 0))
    draw_sample(thumbnail, data, thumbnail_sample, (20, 24, 236, 232), 132)
    detail = Image.new("RGBA", DETAIL_SIZE, (0, 0, 0, 0))
    draw_mixed_sample(detail, data, fallback, detail_runs[0], (32, 24, 928, 148), 96)
    draw_mixed_sample(detail, data, fallback, detail_runs[1], (32, 158, 928, 278), 64)
    draw_mixed_sample(detail, data, fallback, detail_runs[2], (32, 292, 928, 396), 64)
    return {"thumbnail": (_png(thumbnail), THUMBNAIL_SIZE), "detail": (_png(detail), DETAIL_SIZE)}


def _empty_directory(directory: Path) -> None:
    _no_links(directory)
    if directory.exists():
        if not directory.is_dir() or any(directory.iterdir()):
            raise PreviewError("Output must be an empty regular directory")
    else:
        if not directory.parent.is_dir():
            raise PreviewError("Output parent must already exist")
        directory.mkdir()


def create_previews(font_path: Path, directory: Path, font_name: str = "") -> dict:
    _empty_directory(directory)
    data = read_font(font_path)
    images = render(data, font_name)
    _empty_directory(directory)
    manifest = {"schemaVersion": 1, "rendererVersion": RENDERER_VERSION,
                "fontSha256": hashlib.sha256(data).hexdigest()}
    created: list[tuple[Path, bytes]] = []
    try:
        for kind, (content, (width, height)) in images.items():
            sha256 = hashlib.sha256(content).hexdigest()
            filename = sha256 + ".png"
            destination = directory / filename
            with destination.open("xb") as output:
                created.append((destination, content))
                output.write(content)
            manifest[kind] = {"path": filename, "size": len(content), "sha256": sha256,
                              "width": width, "height": height}
        if {entry.name for entry in directory.iterdir()} != {entry.name for entry, _ in created}:
            raise PreviewError("Output directory changed during rendering")
        return manifest
    except Exception:
        # Remove only files this invocation exclusively created, never the user's directory.
        for destination, content in created:
            if destination.is_file() and not destination.is_symlink() and destination.read_bytes() == content:
                destination.unlink()
        raise


def _process_limits() -> None:
    if os.name == "posix":
        import resource
        resource.setrlimit(resource.RLIMIT_CPU, (20, 25))
        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--font", type=Path, required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    try:
        _process_limits()
        if not args.name.strip() or len(args.name) > 256:
            raise PreviewError("Font name must contain between 1 and 256 characters")
        result = create_previews(args.font, args.out, args.name)
    except Exception as error:
        print(f"Font preview error: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
