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
from unittest import mock

sys.dont_write_bytecode = True

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont
from PIL import Image, ImageFont

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
        if visible and name != ".notdef" and characters[order.index(name) - 1] != " ":
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
        self.assertEqual(manifest["rendererVersion"], "font-sample-v2")
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
        self.assertEqual(a["thumbnail"]["sha256"],
                         "02d38cf296ec57db4bf5d65c0566d2e4ee61e020b1ee057147884a699a72249c")
        self.assertEqual(sorted(p.name for p in first.iterdir()), sorted(p.name for p in second.iterdir()))

    def test_fixed_windows_samples_use_source_before_bundled_fallback(self):
        self.assertEqual(renderer.DETAIL_SAMPLES,
                         ("中国智造，慧及全球", "Innovation in China", "0123456789.:;'\"(!?)+-*/="))
        with TTFont(SOURCE_FONT) as font:
            coverage = renderer.Coverage(font)
            runs = [renderer.choose_runs(text, coverage) for text in renderer.DETAIL_SAMPLES]
            choices = {character: run.source for row in runs for run in row for character in run.text}
            self.assertFalse(choices["国"])
            for character in "Innovation in China":
                self.assertFalse(choices[character])
            for character in "中智造慧及全球0123456789":
                self.assertTrue(choices[character])
            for text, row in zip(renderer.DETAIL_SAMPLES, runs):
                self.assertEqual("".join(run.text for run in row), text)
                self.assertTrue(all(a.source != b.source for a, b in zip(row, row[1:])))
                for run in row:
                    for character in run.text:
                        self.assertEqual(run.source, coverage.supports_sample_character(character))

    def test_bundled_fallback_supports_spaces_and_all_fixed_characters(self):
        data = renderer.read_fallback()
        self.assertEqual(hashlib.sha256(data).hexdigest(), renderer.FALLBACK_SHA256)
        with TTFont(io.BytesIO(data)) as font:
            coverage = renderer.Coverage(font)
            self.assertFalse(coverage.has(" "))
            self.assertTrue(coverage.supports_sample_character(" "))
            for text in renderer.DETAIL_SAMPLES:
                self.assertTrue(all(coverage.supports_sample_character(character) for character in text))

    def test_run_offsets_preserve_font_advances_and_empty_space(self):
        source = ImageFont.truetype(io.BytesIO(SOURCE_FONT.read_bytes()), 64,
                                    layout_engine=ImageFont.Layout.RAQM)
        fallback = ImageFont.truetype(io.BytesIO(renderer.read_fallback()), 64,
                                      layout_engine=ImageFont.Layout.RAQM)
        runs = (renderer.FontRun("中", True), renderer.FontRun(" ", False),
                renderer.FontRun("国", False), renderer.FontRun("0", True))
        box, positions = renderer._run_metrics(runs, {True: source, False: fallback})
        self.assertEqual(positions[1], source.getlength("中"))
        self.assertEqual(positions[2], positions[1] + fallback.getlength(" "))
        self.assertEqual(positions[3], positions[2] + fallback.getlength("国"))
        self.assertGreater(positions[2], positions[1])
        self.assertGreater(box[2], box[0]); self.assertGreater(box[3], box[1])

    def test_complete_source_does_not_load_fallback(self):
        font_path = self.directory / "complete.ttf"
        characters = "".join(dict.fromkeys("".join(renderer.DETAIL_SAMPLES)))
        minimal_font(font_path, characters=characters)
        with TTFont(font_path) as font:
            coverage = renderer.Coverage(font)
            self.assertFalse(coverage.has(" "))
            self.assertTrue(coverage.supports_sample_character(" "))
        with mock.patch.object(renderer, "read_fallback", side_effect=AssertionError("unneeded dependency read")):
            manifest = renderer.create_previews(font_path, self.output())
        self.assertEqual(manifest["rendererVersion"], "font-sample-v2")

    def test_invalid_fallback_fails_without_output(self):
        fallback_path = self.directory / "fallback.ttf"
        cases = ((b"wOFF" + bytes(128), "uncompressed TrueType/OpenType SFNT"),
                 (SOURCE_FONT.read_bytes(), "checksum mismatch"))
        for index, (data, message) in enumerate(cases):
            with self.subTest(message=message):
                fallback_path.write_bytes(data)
                output = self.output(f"invalid-{index}")
                with mock.patch.object(renderer, "FALLBACK_PATH", fallback_path):
                    with self.assertRaisesRegex(renderer.PreviewError, message):
                        renderer.create_previews(SOURCE_FONT, output)
                self.assertEqual(list(output.iterdir()), [])
        minimal_font(fallback_path)
        digest = hashlib.sha256(fallback_path.read_bytes()).hexdigest()
        with mock.patch.object(renderer, "FALLBACK_PATH", fallback_path), \
             mock.patch.object(renderer, "FALLBACK_SHA256", digest):
            with self.assertRaisesRegex(renderer.PreviewError, "does not cover the fixed samples"):
                renderer.read_fallback()
        with mock.patch.object(renderer, "FALLBACK_PATH", self.directory / "missing.ttf"):
            with self.assertRaisesRegex(renderer.PreviewError, "Bundled preview fallback is invalid"):
                renderer.read_fallback()

    def test_detail_rows_are_centered_and_do_not_cross_their_bounds(self):
        data, _ = renderer.render(SOURCE_FONT.read_bytes())["detail"]
        with Image.open(io.BytesIO(data)) as image:
            alpha = image.getchannel("A")
            for top, bottom in ((24, 148), (158, 278), (292, 396)):
                bounds = alpha.crop((0, top, 960, bottom)).getbbox()
                self.assertIsNotNone(bounds)
                self.assertGreaterEqual(bounds[0], 32)
                self.assertLessEqual(bounds[2], 928)
                self.assertLessEqual(abs((bounds[0] + bounds[2]) / 2 - 480), 1)
            for top, bottom in ((0, 24), (148, 158), (278, 292), (396, 420)):
                self.assertIsNone(alpha.crop((0, top, 960, bottom)).getbbox())

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
        with mock.patch.object(renderer, "read_fallback", side_effect=AssertionError("source validation skipped")):
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
