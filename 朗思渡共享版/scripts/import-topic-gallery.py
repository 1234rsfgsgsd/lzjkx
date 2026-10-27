"""Import the owner's named theme folders without altering the source archive."""
import argparse
import io
import json
import pathlib
import zipfile
from collections import Counter

from PIL import Image, ImageOps


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=pathlib.Path)
    parser.add_argument("--gallery", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[1] / "gallery")
    args = parser.parse_args()
    gallery = args.gallery.resolve()
    manifest_path = gallery / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    themes = {theme["name"]: theme for theme in manifest["themes"]}
    counts = Counter()
    source_bytes = output_bytes = 0
    prepared = []
    with zipfile.ZipFile(args.archive) as archive:
        for item in sorted(archive.infolist(), key=lambda item: item.filename):
            if item.is_dir():
                continue
            source = pathlib.PurePosixPath(item.filename.replace("\\", "/"))
            if source.is_absolute() or ".." in source.parts or len(source.parts) != 2:
                raise ValueError(f"Unexpected image path: {source}")
            theme_name = source.parts[0]
            if theme_name not in themes or source.suffix.lower() not in {".jpg", ".jpeg", ".png", ".webp"}:
                raise ValueError(f"Unknown theme or file format: {source}")
            if item.file_size > 20 * 1024 * 1024:
                raise ValueError(f"Image exceeds import size limit: {source}")
            data = archive.read(item)
            with Image.open(io.BytesIO(data)) as original:
                original.load()
                image = ImageOps.exif_transpose(original)
                if image.mode not in {"RGB", "RGBA"}:
                    image = image.convert("RGBA" if "transparency" in image.info else "RGB")
                image.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
                output = io.BytesIO()
                image.save(output, format="WEBP", quality=90, method=4)
                encoded = output.getvalue()
            relative = source.with_suffix(".webp").as_posix()
            target = (gallery / relative).resolve()
            if not target.is_relative_to(gallery) or target.exists():
                raise ValueError(f"Refusing to overwrite a gallery file: {relative}")
            prepared.append((target, encoded, theme_name, relative, source.as_posix()))
            source_bytes += len(data)
            output_bytes += len(encoded)
    # Validate every source before changing the public manifest.
    for target, encoded, theme_name, relative, source in prepared:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(encoded)
        counts[theme_name] += 1
        themes[theme_name]["images"].append({"file": relative, "label": f"{theme_name}场景 {counts[theme_name]:02d}", "source": source})
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"imported": len(prepared), "counts": dict(counts), "sourceMB": round(source_bytes / 1024**2, 2), "websiteMB": round(output_bytes / 1024**2, 2), "emptyThemes": [name for name, theme in themes.items() if not theme["images"]]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
