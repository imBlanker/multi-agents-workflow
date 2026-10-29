#!/usr/bin/env python3
"""Produce the reviewed offline JSON snapshot from the exact upstream source blob.
No upstream Rust, SQL or shell is executed. This is a build/data export tool.
"""
import datetime
import hashlib
import json
import math
import re
import sys
from pathlib import Path

SOURCE_REF = '939d4594e64ce23bf250f42b6cec9f22c4caa913'
SOURCE_HASH = '443c986a99b8973e6a46adf707b10e47fce6d6fcb0885372cb691ee1972bd273'
raw = Path(sys.argv[1]).read_bytes()
if hashlib.sha256(raw).hexdigest() != SOURCE_HASH:
    raise ValueError('Pinned upstream source hash mismatch')
text = raw.decode('utf-8')
section = text.split('fn seed_model_pricing(', 1)[1].split('let pricing_data = [', 1)[1].split('\n        ];', 1)[0]
pattern = (r'\(\s*"([^"\\]*)"\s*,\s*"([^"\\]*)"\s*,'
           r'\s*"([0-9.]+)"\s*,\s*"([0-9.]+)"\s*,'
           r'\s*"([0-9.]+)"\s*,\s*"([0-9.]+)"\s*,?\s*\)')
rows = re.findall(pattern, section)
remainder = re.sub(pattern, '', section)
remainder = re.sub(r'//[^\n]*', '', remainder)
if re.sub(r'[\s,]', '', remainder) or len(rows) != 222 or len({row[0] for row in rows}) != 222:
    raise ValueError('Unexpected pricing array shape or count')
retrieved = datetime.datetime.now(datetime.timezone.utc).isoformat()
records = []
for model, display, inp, out, cache_read, cache_write in rows:
    values = [float(value) for value in (inp, out, cache_read, cache_write)]
    if any(not math.isfinite(value) or value < 0 for value in values):
        raise ValueError('Invalid upstream numeric field')
    notes = ['Upstream seed has no provider identity; supplier applicability is unverified and this is an estimate']
    if values[2] == 0 or values[3] == 0:
        notes.append('Upstream zero cache fields conservatively treated as unsupported/unknown, not free caching')
    records.append(dict(sourceId='pricing.cc-switch-upstream', sourceVersion=SOURCE_REF,
        sourceHash=SOURCE_HASH, retrievedAt=retrieved, currency='USD', unit='USD/1M tokens',
        providerId=None, modelId=model, displayName=display,
        inputPerMillion=values[0], outputPerMillion=values[1],
        cacheReadPerMillion=values[2] or None, cacheWritePerMillion=values[3] or None,
        applicability={'providerScope':'unverified','serviceMode':'standard'},
        estimated=True, stale=False, notes=notes))
output = dict(schemaVersion=1, sourceId='pricing.cc-switch-upstream', sourceVersion=SOURCE_REF,
    sourceUrl='https://api.github.com/repos/farion1231/cc-switch/git/blobs/'+SOURCE_REF,
    sourceHash=SOURCE_HASH, sourceBytes=len(raw), retrievedAt=retrieved, records=records)
Path(sys.argv[2]).write_text(json.dumps(output, ensure_ascii=False, indent=2)+'\n')
print(f'Exported {len(records)} records from verified {len(raw)} source bytes')
