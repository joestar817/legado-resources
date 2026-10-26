"""Renderer tests use the checked-in font and temporary, minimal source-font fixtures."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "tools/render-font-preview.py"
SOURCE_FONT = ROOT / "resources/fonts/ss-fengyun-title/font.ttf"
spec = importlib.util.spec_from_file_location("font_preview_renderer", SCRIPT)
renderer = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = renderer
spec.loader.exec_module(renderer)


def minimal_font(path, characters="X", visible=True):
    builder = FontBuilder(1000, isTTF=True)
    order = [".notdef"] + [f"glyph{index}" for index in range(len(characters))]
    builder.setupGlyphOrder(order)
    builder.setupCharacterMap({ord(character): name for character, name in zip(characters, order[1:])})
    glyphs = {}
    for name in order:
        pen = TTGlyphPen(None)
        if visible and name != ".notdef":
            pen.moveTo((80, 0)); pen.lineTo((520, 0)); pen.lineTo((520, 720))
            pen.lineTo((80, 720)); pen.closePath()
        glyphs[name] = pen.glyph()
    builder.setupGlyf(glyphs)
    builder.setupHorizontalMetrics({name: (600, 0) for name in order})
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    builder.setupNameTable({"familyName": "Preview Test", "styleName": "Regular",
                           "uniqueFontIdentifier": "Preview Test Regular", "fullName": "Preview Test Regular",
                           "psName": "PreviewTest-Regular", "version": "Version 1.0"})
    builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
    builder.setupPost()
    builder.setupMaxp()
    builder.save(path)


class FontPreviewTest(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="legado-font-preview-test-")
        self.directory = Path(self.scratch.name)
        self.addCleanup(self.scratch.cleanup)

    def output(self, name="output"):
        directory = self.directory / name
        directory.mkdir()
        return directory

    def assert_images(self, manifest, output):
        self.assertEqual(manifest["schemaVersion"], 1)
        self.assertEqual(manifest["rendererVersion"], "font-sample-v1")
        self.assertEqual(set(manifest), {"schemaVersion", "rendererVersion", "fontSha256", "thumbnail", "detail"})
        for kind, expected in (("thumbnail", (256, 256)), ("detail", (960, 420))):
            item = manifest[kind]
            data = (output / item["path"]).read_bytes()
            self.assertEqual(item["path"], item["sha256"] + ".png")
            self.assertEqual(item["sha256"], hashlib.sha256(data).hexdigest())
            self.assertEqual(item["size"], len(data))
            self.assertLessEqual(len(data), 1024 * 1024)
            self.assertEqual((item["width"], item["height"]), expected)
            with Image.open(io.BytesIO(data)) as image:
                image.load()
                self.assertEqual(image.size, expected)
                self.assertEqual(image.mode, "RGBA")
                self.assertEqual(image.getpixel((0, 0)), (0, 0, 0, 0))
                self.assertEqual(image.convert("RGB").getextrema(), ((0, 0), (0, 0), (0, 0)))
                bounds = image.getchannel("A").getbbox()
                self.assertIsNotNone(bounds)
                self.assertGreater(bounds[0], 0); self.assertGreater(bounds[1], 0)
                self.assertLess(bounds[2], image.width); self.assertLess(bounds[3], image.height)
                self.assertFalse(image.info)

    def test_real_font_coverage_excludes_missing_letters_and_characters(self):
        with TTFont(SOURCE_FONT) as font:
            coverage = renderer.Coverage(font)
            self.assertFalse(coverage.contains("AaBb"))
            self.assertFalse(coverage.contains("中国智造"))
            self.assertTrue(coverage.contains("天地玄黄宇宙洪荒"))
            primary, numbers, thumbnail = renderer.choose_samples(coverage)
            self.assertEqual(primary.text, "天地玄黄宇宙洪荒")
            self.assertEqual(numbers.text, "0123456789")
            self.assertEqual(thumbnail.text, "天地")
            for sample in (primary, numbers, thumbnail):
                self.assertTrue(coverage.contains(sample.text))

    def test_real_font_is_deterministic_bounded_and_source_unchanged(self):
        original = SOURCE_FONT.read_bytes()
        first, second = self.output("first"), self.output("second")
        a = renderer.create_previews(SOURCE_FONT, first)
        b = renderer.create_previews(SOURCE_FONT, second)
        self.assertEqual(a, b)
        self.assertEqual(a["fontSha256"], hashlib.sha256(original).hexdigest())
        self.assertEqual(SOURCE_FONT.read_bytes(), original)
        self.assert_images(a, first)
        self.assertEqual(sorted(p.name for p in first.iterdir()), sorted(p.name for p in second.iterdir()))

    def test_single_visible_character_uses_real_glyph_gallery(self):
        font_path = self.directory / "single.ttf"
        minimal_font(font_path)
        with TTFont(font_path) as font:
            primary, numbers, thumbnail = renderer.choose_samples(renderer.Coverage(font))
            self.assertEqual(primary, renderer.Sample("X", isolated=True))
            self.assertEqual(numbers, primary)
            self.assertEqual(thumbnail.text, "X")
        output = self.output()
        manifest = renderer.create_previews(font_path, output)
        self.assert_images(manifest, output)

    def test_empty_outlines_are_rejected_without_images(self):
        font_path = self.directory / "empty.ttf"
        minimal_font(font_path, visible=False)
        output = self.output()
        with self.assertRaisesRegex(renderer.PreviewError, "no supported visible"):
            renderer.create_previews(font_path, output)
        self.assertEqual(list(output.iterdir()), [])

    def test_corrupt_font_has_no_success_manifest_or_output(self):
        font_path = self.directory / "corrupt.ttf"
        font_path.write_bytes(b"This is not a font")
        output = self.output()
        result = subprocess.run([sys.executable, str(SCRIPT), "--font", str(font_path), "--out", str(output)],
                                capture_output=True, text=True, timeout=30)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("Font preview error:", result.stderr)
        self.assertEqual(list(output.iterdir()), [])

    def test_oversized_input_is_rejected_before_loading(self):
        font_path = self.directory / "large.ttf"
        with font_path.open("wb") as font:
            font.truncate(renderer.MAX_FONT_BYTES + 1)
        with self.assertRaisesRegex(renderer.PreviewError, "at most 64 MiB"):
            renderer.read_font(font_path)

    def test_compressed_or_collection_fonts_cannot_hide_behind_ttf_extension(self):
        font_path = self.directory / "disguised.ttf"
        for magic in (b"wOFF", b"wOF2", b"ttcf", b"true"):
            with self.subTest(magic=magic):
                content = magic + bytes(128)
                font_path.write_bytes(content)
                with self.assertRaisesRegex(renderer.PreviewError, "uncompressed TrueType/OpenType SFNT"):
                    renderer.read_font(font_path)
                with self.assertRaisesRegex(renderer.PreviewError, "uncompressed TrueType/OpenType SFNT"):
                    renderer.render(content)

    def test_nonempty_output_and_relative_paths_are_rejected(self):
        output = self.output()
        preserved = output / "do-not-delete.txt"
        preserved.write_text("user file", encoding="utf-8")
        with self.assertRaisesRegex(renderer.PreviewError, "empty regular directory"):
            renderer.create_previews(SOURCE_FONT, output)
        self.assertEqual(preserved.read_text(encoding="utf-8"), "user file")
        with self.assertRaisesRegex(renderer.PreviewError, "absolute"):
            renderer.read_font(Path("relative.ttf"))

    def test_symlink_source_output_and_parent_are_rejected(self):
        source_link = self.directory / "source.ttf"
        try:
            source_link.symlink_to(SOURCE_FONT)
        except OSError as error:
            self.skipTest(f"Symlinks unavailable: {error}")
        with self.assertRaisesRegex(renderer.PreviewError, "Symbolic links"):
            renderer.read_font(source_link)
        output = self.output()
        output_link = self.directory / "output-link"
        output_link.symlink_to(output, target_is_directory=True)
        with self.assertRaisesRegex(renderer.PreviewError, "Symbolic links"):
            renderer.create_previews(SOURCE_FONT, output_link)
        with self.assertRaisesRegex(renderer.PreviewError, "Symbolic links"):
            renderer.create_previews(SOURCE_FONT, output_link / "child")
        self.assertEqual(list(output.iterdir()), [])

    def test_cli_prints_only_json_and_accepts_existing_empty_output(self):
        output = self.output()
        result = subprocess.run([sys.executable, str(SCRIPT), "--font", str(SOURCE_FONT), "--out", str(output)],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        manifest = json.loads(result.stdout)
        self.assertEqual(result.stderr, "")
        self.assert_images(manifest, output)


if __name__ == "__main__":
    unittest.main()
