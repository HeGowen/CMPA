import QtQuick
import QtQuick.Controls

ApplicationWindow {
    id: root
    width: 640
    height: 480
    visible: true
    title: "Digital Human Demo"

    Image {
        id: digitalHumanDisplay
        anchors.fill: parent
        source: "image://digitalHuman/frame"
        cache: false 
    }

    Timer {
        interval: 33 // ~30 FPS
        running: true
        repeat: true
        onTriggered: {
            // By changing the source, we force a reload from the provider
            var oldSource = digitalHumanDisplay.source
            digitalHumanDisplay.source = ""
            digitalHumanDisplay.source = oldSource
        }
    }
}
