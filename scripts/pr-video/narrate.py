"""Speaks each narrated step of a demo video, locally (Kokoro-82M through kokoro-onnx, CPU), and writes one WAV per step.

    python narrate.py <job.json>

job.json: {"model": path, "voices": path, "voice": "af_heart", "speed": 1.0, "lang": "en-us", "out": dir,
           "steps": [{"id": "s1", "text": "..."}]}
Writes <out>/<id>.wav and prints one JSON line: {"steps": [{"id", "file", "seconds"}]}. The texts were redacted by the
harness before this runs (scripts/pr-video/lib/render.mjs); nothing here reads or writes anything else.
"""

import json
import os
import sys


def main(job_file):
    with open(job_file, encoding="utf-8") as f:
        job = json.load(f)
    from kokoro_onnx import Kokoro  # imported here: a missing toolchain fails with a clear message below
    import soundfile as sf

    kokoro = Kokoro(job["model"], job["voices"])
    os.makedirs(job["out"], exist_ok=True)
    out = []
    for step in job["steps"]:
        text = (step.get("text") or "").strip()
        if not text:
            continue
        samples, rate = kokoro.create(text, voice=job.get("voice", "af_heart"), speed=float(job.get("speed", 1.0)), lang=job.get("lang", "en-us"))
        file = os.path.join(job["out"], f"{step['id']}.wav")
        sf.write(file, samples, rate)
        out.append({"id": step["id"], "file": file, "seconds": round(len(samples) / rate, 3)})
    print(json.dumps({"steps": out}))


if __name__ == "__main__":
    try:
        main(sys.argv[1])
    except ImportError as e:
        print(json.dumps({"error": f"narration toolchain missing: {e} (factory video install)"}))
        sys.exit(2)
