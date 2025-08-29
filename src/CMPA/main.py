import sys
from pathlib import Path
import time
import cv2
import numpy as np
from PySide6.QtCore import QObject, QTimer, QUrl
from PySide6.QtGui import QImage, QPixmap
from PySide6.QtQml import QQmlApplicationEngine
from PySide6.QtQuick import QQuickImageProvider
from PySide6.QtWidgets import QApplication

# This will hold the latest frame
latest_frame = None

class DigitalHumanProvider(QQuickImageProvider):
    def __init__(self):
        super().__init__(QQuickImageProvider.ImageType.Pixmap)

    def requestPixmap(self, id, size, requestedSize):
        if latest_frame is not None:
            return QPixmap.fromImage(latest_frame), latest_frame.size()
        
        # Return a placeholder if no frame is ready
        placeholder = QPixmap(640, 480)
        placeholder.fill(0)
        return placeholder, placeholder.size()

class Backend(QObject):
    def __init__(self):
        super().__init__()
        self.timer = QTimer()
        self.timer.setInterval(33)  # ~30 FPS
        self.timer.timeout.connect(self.generate_frame)
        self.timer.start()

    def generate_frame(self):
        global latest_frame
        height, width = 480, 640
        frame = np.zeros((height, width, 3), dtype=np.uint8)
        
        now = time.localtime()
        center = (width // 2, height // 2)
        radius = 180
        
        # Draw clock face
        cv2.circle(frame, center, radius, (255, 255, 255), 2)

        # Second hand
        sec_angle = (now.tm_sec / 60) * 360 - 90
        sec_x = int(center[0] + (radius - 10) * np.cos(np.deg2rad(sec_angle)))
        sec_y = int(center[1] + (radius - 10) * np.sin(np.deg2rad(sec_angle)))
        cv2.line(frame, center, (sec_x, sec_y), (255, 0, 0), 1)

        # Minute hand
        min_angle = ((now.tm_min + now.tm_sec / 60) / 60) * 360 - 90
        min_x = int(center[0] + (radius - 40) * np.cos(np.deg2rad(min_angle)))
        min_y = int(center[1] + (radius - 40) * np.sin(np.deg2rad(min_angle)))
        cv2.line(frame, center, (min_x, min_y), (0, 255, 0), 3)

        # Hour hand
        hour_angle = ((now.tm_hour % 12 + now.tm_min / 60) / 12) * 360 - 90
        hour_x = int(center[0] + (radius - 80) * np.cos(np.deg2rad(hour_angle)))
        hour_y = int(center[1] + (radius - 80) * np.sin(np.deg2rad(hour_angle)))
        cv2.line(frame, center, (hour_x, hour_y), (0, 0, 255), 5)
        
        # Convert numpy array to QImage
        latest_frame = QImage(frame.data, width, height, 3 * width, QImage.Format.Format_RGB888).rgbSwapped()

if __name__ == "__main__":
    app = QApplication(sys.argv)
    engine = QQmlApplicationEngine()

    provider = DigitalHumanProvider()
    engine.addImageProvider("digitalHuman", provider)

    # Backend to generate frames
    backend = Backend()
    
    qml_file = Path(__file__).parent / "main.qml"
    engine.load(qml_file)

    if not engine.rootObjects():
        sys.exit(-1)

    sys.exit(app.exec())
