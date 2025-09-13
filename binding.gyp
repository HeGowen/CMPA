{
  "targets": [
    {
      "target_name": "ble_capture",
      "sources": [
        "src/ble_common.h",
        "src/ble_win.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "defines": [ "NAPI_CPP_EXCEPTIONS" ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions": [ "/std:c++20", "/EHsc", "/permissive-", "/bigobj", "/utf-8" ],
          "PreprocessorDefinitions": [ "WIN32_LEAN_AND_MEAN", "UNICODE", "_UNICODE" ]
        },
        "VCLinkerTool": {
          "AdditionalDependencies": [ "WindowsApp.lib" ]
        }
      }
    }
  ]
}
