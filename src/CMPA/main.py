import sys
import json
import subprocess
from pathlib import Path

import cv2
import numpy as np
from PySide6.QtCore import (
    QObject,
    Property,
    QTimer,
    QUrl,
    Signal,
    Slot,
)
from PySide6.QtGui import QGuiApplication
from PySide6.QtMultimedia import QMediaPlayer, QAudioOutput
from PySide6.QtQml import QQmlApplicationEngine, qmlRegisterSingletonType

# --- Constants ---
VISEME_SIZE = (128, 128)
VISEME_CHARS = ["A", "B", "C", "D", "E", "F", "G", "H", "X"]
ASSETS_DIR = Path(__file__).parent.parent / "assets"
VISEMES_DIR = ASSETS_DIR / "visemes"
TOOLS_DIR = Path(__file__).parent.parent / "tools"
PIPER_EXE = TOOLS_DIR / "piper" / "piper"
RHUBARB_EXE = TOOLS_DIR / "rhubarb_lipsync" / "rhubarb"
VOICE_MODEL = TOOLS_DIR / "piper" / "en_US-lessac-medium.onnx"

class DigitalHuman(QObject):
    currentMouthImageChanged = Signal()

    def __init__(self):
        super().__init__()
        self._current_mouth_image = QUrl.fromLocalFile(
            str(VISEMES_DIR / "X.png")
        )
        self._player = QMediaPlayer()
        self._audio_output = QAudioOutput()
        self._player.setAudioOutput(self._audio_output)

        self._viseme_data = []
        self._viseme_index = 0
        self._timer = QTimer()
        self._timer.setInterval(10)  # Check every 10ms
        self._timer.timeout.connect(self._update_viseme)

    @Property(QUrl, notify=currentMouthImageChanged)
    def currentMouthImage(self):
        return self._current_mouth_image

    def _set_current_mouth_image(self, viseme_char):
        path = VISEMES_DIR / f"{viseme_char}.png"
        if path.exists():
            url = QUrl.fromLocalFile(str(path))
            if self._current_mouth_image != url:
                self._current_mouth_image = url
                self.currentMouthImageChanged.emit()

    @Slot(str)
    def speak(self, text):
        if not text.strip():
            return

        # --- 1. Generate Audio with Piper ---
        wav_path = ASSETS_DIR / "output.wav"
        subprocess.run(
            [
                str(PIPER_EXE),
                "-m",
                str(VOICE_MODEL),
                "-f",
                str(wav_path),
            ],
            input=text,
            encoding="utf-8",
            capture_output=True,
        )

        # --- 2. Generate Lip Sync data with Rhubarb ---
        lips_json_path = ASSETS_DIR / "lips.json"
        subprocess.run(
            [
                str(RHUBARB_EXE),
                "-f",
                "json",
                "--extended",
                str(wav_path),
                "-o",
                str(lips_json_path),
            ]
        )

        # --- 3. Play Audio and Animate ---
        with open(lips_json_path, "r") as f:
            self._viseme_data = json.load(f)["mouthCues"]
        
        self._viseme_index = 0
        self._player.setSource(QUrl.fromLocalFile(str(wav_path)))
        self._player.play()
        self._timer.start()

    def _update_viseme(self):
        if self._player.playbackState() != QMediaPlayer.PlaybackState.Playing:
            self._timer.stop()
            self._set_current_mouth_image("X") # Reset to neutral
            return

        elapsed_ms = self._player.position()
        elapsed_sec = elapsed_ms / 1000.0

        if self._viseme_index >= len(self._viseme_data):
            return

        cue = self._viseme_data[self._viseme_index]
        if elapsed_sec >= cue["start"]:
            self._set_current_mouth_image(cue["value"])
            if elapsed_sec > cue["end"]:
                 self._viseme_index += 1

def create_viseme_placeholders():
    if VISEMES_DIR.exists() and any(VISEMES_DIR.iterdir()):
        print("Viseme images already exist.")
        return

    VISEMES_DIR.mkdir(parents=True, exist_ok=True)
    for char in VISEME_CHARS:
        img = np.zeros((VISEME_SIZE[0], VISEME_SIZE[1], 3), dtype=np.uint8)
        img.fill(255) # White background
        font = cv2.FONT_HERSHEY_SIMPLEX
        text_size = cv2.getTextSize(char, font, 3, 5)[0]
        text_x = (img.shape[1] - text_size[0]) // 2
        text_y = (img.shape[0] + text_size[1]) // 2
        cv2.putText(img, char, (text_x, text_y), font, 3, (0, 0, 0), 5)
        cv2.imwrite(str(VISEMES_DIR / f"{char}.png"), img)
    print("Generated viseme placeholder images.")

if __name__ == "__main__":
    create_viseme_placeholders()
    app = QGuiApplication(sys.argv)

    qmlRegisterSingletonType(DigitalHuman, "com.company.cmpa", 1, 0, "DigitalHuman")

    engine = QQmlApplicationEngine()
    qml_file = Path(__file__).parent / "main.qml"
    engine.load(qml_file)

    if not engine.rootObjects():
        sys.exit(-1)

    sys.exit(app.exec())