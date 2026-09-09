"""Bounded, non-extracting reader for SpawnBox diagnostic zstd/tar packages."""
import io
import json
import sys
import tarfile
import zstandard

paths = json.loads(sys.argv[1])  # Numerically ordered by the service, never glob order.
member_name = sys.argv[2]
offset = int(sys.argv[3])
MAX_COMPRESSED = 64 * 1024 * 1024
MAX_EXPANDED = 256 * 1024 * 1024

compressed = bytearray()
for path in paths:
    with open(path, "rb") as source:
        compressed.extend(source.read(MAX_COMPRESSED + 1))
    if len(compressed) > MAX_COMPRESSED:
        raise ValueError("compressed diagnostic exceeds limit")

with zstandard.ZstdDecompressor(max_window_size=128 * 1024).stream_reader(io.BytesIO(compressed)) as stream:
    expanded = stream.read(MAX_EXPANDED + 1)
    if len(expanded) > MAX_EXPANDED:
        raise ValueError("expanded diagnostic exceeds limit")

inventory = []
result = None
with tarfile.open(fileobj=io.BytesIO(expanded), mode="r:") as archive:
    for member in archive:
        if len(inventory) >= 10000:
            raise ValueError("diagnostic has too many members")
        inventory.append({"name": member.name, "size": member.size, "regular": member.isfile()})
        if member_name and member.name == member_name:
            if not member.isfile() or member.size > 32 * 1024 * 1024:
                raise ValueError("requested member is not a bounded regular file")
            if not member.name.lower().endswith((".log", ".txt", ".json", ".toml", ".yaml", ".yml", ".md", ".csv")):
                raise ValueError("use the local operator for binary diagnostic analysis")
            source = archive.extractfile(member)
            source.seek(offset)
            text = source.read(24000).decode("utf-8", errors="replace")
            result = {"member": member.name, "text": text, "totalBytes": member.size,
                      "nextOffset": offset + 24000 if offset + 24000 < member.size else None}
if member_name and result is None:
    raise ValueError("member is absent; inspect inventory instead of guessing")
print(json.dumps(result if member_name else {"inventory": inventory}))
