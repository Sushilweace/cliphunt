#!/usr/bin/env python3
"""Free local transcription. pip install faster-whisper
Usage: transcribe_local.py audio.wav [model_size]   -> prints JSON in the app's transcript format."""
import sys, json
import av

# faster-whisper 1.2 passes metadata_errors, which PyAV 19 does not accept.
_open = av.open
def _open_compat(*args, **kwargs):
    kwargs.pop("metadata_errors", None)
    return _open(*args, **kwargs)
av.open = _open_compat

from faster_whisper import WhisperModel

wav = sys.argv[1]
# This PC has no CUDA runtime (cublas64_12.dll), so the GPU build cannot load.
model = WhisperModel(sys.argv[2] if len(sys.argv) > 2 else "small", device="cpu", compute_type="int8")
segs, info = model.transcribe(wav, word_timestamps=True, vad_filter=True)
out = []
for s in segs:
    words = [{"w": w.word.strip(), "s": w.start, "e": w.end} for w in (s.words or [])]
    out.append({"start": s.start, "end": s.end, "text": s.text.strip(), "words": words})
print(json.dumps({"language": info.language, "segments": out}))
