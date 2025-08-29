import sys
from PySide6.QtWidgets import QApplication, QWidget, QLabel, QVBoxLayout

class MainWindow(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("CMPA Application")
        self.layout = QVBoxLayout(self)
        self.label = QLabel("Hello, World!")
        self.layout.addWidget(self.label)
        self.resize(300, 150)

if __name__ == "__main__":
    app = QApplication(sys.argv)
    window = MainWindow()
    window.show()
    sys.exit(app.exec())
