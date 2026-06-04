import argparse
import json
import sys


def main():
    parser = argparse.ArgumentParser(description="Local speech-to-text bridge for County Signal Map.")
    parser.add_argument("audio_path")
    parser.add_argument("--model", default="large-v3-turbo")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--compute-type", default="default")
    parser.add_argument("--language", default="en")
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(
            json.dumps(
                {
                    "error": "Python package faster-whisper is not installed. Run: python -m pip install -r requirements-local.txt"
                }
            )
        )
        return 2

    try:
        model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
        segments, _info = model.transcribe(
            args.audio_path,
            language=args.language or None,
            beam_size=5,
            vad_filter=True,
            condition_on_previous_text=False,
        )
        transcript = " ".join(segment.text.strip() for segment in segments).strip()
        print(json.dumps({"transcript": transcript}))
        return 0
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
