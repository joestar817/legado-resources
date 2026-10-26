#!/usr/bin/env python3
"""Rebuild the small, renamed OFL fallback from a pinned upstream font; no network."""
import argparse
import hashlib
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

SOURCE_SHA256 = "a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da"
CHARACTERS = set(range(0x20, 0x7F)) | {ord(character) for character in "中国智造，慧及全球"}


def build(source: Path, destination: Path) -> None:
    data = source.read_bytes()
    if hashlib.sha256(data).hexdigest() != SOURCE_SHA256:
        raise ValueError("Use the pinned Noto Sans SC upstream source documented in tools/fonts/README.md")
    if destination.exists():
        raise ValueError("Refusing to overwrite an existing font")
    with TTFont(source, recalcTimestamp=False) as font:
        created, modified = font["head"].created, font["head"].modified
        options = subset.Options()
        options.name_IDs = ["*"]
        options.name_languages = ["*"]
        options.name_legacy = True
        selected = subset.Subsetter(options=options)
        selected.populate(unicodes=CHARACTERS)
        selected.subset(font)
        instantiateVariableFont(font, {"wght": 400}, inplace=True)
        replacements = {
            1: "NG Preview Fallback", 2: "Regular", 3: "NGPreviewFallback-Regular-1.0",
            4: "NG Preview Fallback Regular", 6: "NGPreviewFallback-Regular",
            16: "NG Preview Fallback", 17: "Regular",
        }
        for record in list(font["name"].names):
            if record.nameID in replacements:
                font["name"].setName(replacements[record.nameID], record.nameID,
                                     record.platformID, record.platEncID, record.langID)
        font["head"].created, font["head"].modified = created, modified
        font.recalcTimestamp = False
        if not CHARACTERS <= set(font.getBestCmap() or {}):
            raise ValueError("Fallback subset is missing required sample characters")
        destination.parent.mkdir(parents=True, exist_ok=True)
        font.save(destination)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    build(args.source, args.out)
    print(hashlib.sha256(args.out.read_bytes()).hexdigest())
