import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zstandard

HELPER = Path(__file__).resolve().parents[1] / "scripts" / "diag-reader.py"


class DiagnosticReaderTests(unittest.TestCase):
    def bundle(self, tar):
        folder = Path(tempfile.mkdtemp(prefix="help-diag-test-"))
        compressed = zstandard.ZstdCompressor().compress(tar.getvalue())
        chunks = []
        # More than ten pieces protects numeric part ordering.
        step = max(1, len(compressed) // 12)
        for index, offset in enumerate(range(0, len(compressed), step)):
            path = folder / f"part_{index}.zst"
            path.write_bytes(compressed[offset:offset + step])
            chunks.append(str(path))
        return chunks

    def test_inventory_and_paged_member_without_extracting(self):
        tar = io.BytesIO()
        content = b"measured log data\n" * 3000
        with tarfile.open(fileobj=tar, mode="w") as archive:
            info = tarfile.TarInfo("logs/backend.log")
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))
        paths = self.bundle(tar)
        inventory = subprocess.check_output([sys.executable, str(HELPER), json.dumps(paths), "", "0"])
        self.assertEqual(json.loads(inventory)["inventory"][0]["name"], "logs/backend.log")
        member = subprocess.check_output([sys.executable, str(HELPER), json.dumps(paths), "logs/backend.log", "24000"])
        self.assertEqual(json.loads(member)["text"], content[24000:48000].decode())
        self.assertFalse((Path(paths[0]).parent / "logs").exists())

    def test_archive_links_never_become_local_reads(self):
        tar = io.BytesIO()
        with tarfile.open(fileobj=tar, mode="w") as archive:
            info = tarfile.TarInfo("auth.txt")
            info.type = tarfile.SYMTYPE
            info.linkname = "../../credentials.txt"
            archive.addfile(info)
        result = subprocess.run([sys.executable, str(HELPER), json.dumps(self.bundle(tar)), "auth.txt", "0"], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"bounded regular file", result.stderr)


if __name__ == "__main__":
    unittest.main()
