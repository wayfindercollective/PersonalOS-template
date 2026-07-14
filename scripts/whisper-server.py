#!/usr/bin/env python3
"""Local Whisper WebSocket server using openai-whisper on AMD GPU."""

import asyncio
import json
import os
import tempfile
import time

import websockets
import whisper

os.environ["HIP_VISIBLE_DEVICES"] = "0"
os.environ["ROCR_VISIBLE_DEVICES"] = "0"

MODEL_SIZE = "base"
PORT = 9091

print(f"Loading Whisper model '{MODEL_SIZE}' on GPU...")
model = whisper.load_model(MODEL_SIZE, device="cuda")
print(f"Model loaded on GPU. Listening on ws://0.0.0.0:{PORT}")


async def transcribe(websocket):
    audio_data = await websocket.recv()

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as tmp:
        tmp.write(audio_data)
        tmp.flush()

        start = time.time()
        result = model.transcribe(tmp.name, fp16=True)
        elapsed = round(time.time() - start, 3)

    response = {
        "text": result["text"].strip(),
        "language": result.get("language", ""),
        "duration": round(result["segments"][-1]["end"], 3) if result["segments"] else 0,
        "processing_time": elapsed,
    }
    await websocket.send(json.dumps(response))


async def main():
    async with websockets.serve(transcribe, "0.0.0.0", PORT, max_size=10 * 1024 * 1024):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
