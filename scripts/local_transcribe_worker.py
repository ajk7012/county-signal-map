import argparse
import json
import sys


def emit(payload):
    print(json.dumps(payload), flush=True)


def main():
    parser = argparse.ArgumentParser(description="Persistent local speech-to-text worker.")
    parser.add_argument("--model", default="large-v3-turbo")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--compute-type", default="default")
    parser.add_argument("--language", default="en")
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        emit(
            {
                "type": "ready",
                "error": "Python package faster-whisper is not installed. Run: python -m pip install -r requirements-local.txt",
            }
        )
        return 2

    try:
        emit({"type": "loading", "model": args.model})
        model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
        emit({"type": "ready", "model": args.model})
    except Exception as exc:
        emit({"type": "ready", "error": str(exc)})
        return 1

    for line in sys.stdin:
        try:
            request = json.loads(line)
            request_id = request["id"]
            audio_path = request["audioPath"]
        except Exception as exc:
            emit({"type": "result", "id": None, "error": f"Invalid worker request: {exc}"})
            continue

        try:
            segments, _info = model.transcribe(
                audio_path,
                language=args.language or None,
                beam_size=3,
                vad_filter=True,
                condition_on_previous_text=False,
            )
            transcript = " ".join(segment.text.strip() for segment in segments).strip()
            emit({"type": "result", "id": request_id, "transcript": transcript})
        except Exception as exc:
            emit({"type": "result", "id": request_id, "error": str(exc)})

    return 0


if __name__ == "__main__":
    sys.exit(main())
