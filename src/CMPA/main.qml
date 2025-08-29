import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import com.company.cmpa 1.0

ApplicationWindow {
    id: root
    width: 400
    height: 480
    visible: true
    title: "Digital Human Lip Sync"

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 16

        Image {
            id: mouthImage
            source: DigitalHuman.currentMouthImage
            Layout.alignment: Qt.AlignHCenter
            Layout.fillWidth: true
            Layout.preferredHeight: 200
            fillMode: Image.PreserveAspectFit
        }

        Label {
            text: "Enter text to speak:"
            Layout.topMargin: 16
        }

        TextField {
            id: textInput
            text: "Hello world, this is a test."
            placeholderText: "Type something..."
            Layout.fillWidth: true
        }

        Button {
            id: speakButton
            text: "Speak"
            Layout.alignment: Qt.AlignHCenter
            Layout.topMargin: 8
            onClicked: {
                DigitalHuman.speak(textInput.text)
            }
        }
    }
}