#pragma once
#include <functional>
#include <string>
#include <vector>
#include <cstdint>

struct BleOptions {
  std::string namePrefix;   // 用于广告名前缀匹配（可选）
  std::string serviceUUID;  // 可留空
  std::string notifyUUID;   // 必填：通知特征 UUID
};

struct DataEvent {
  uint64_t lastPacketBytes{0};
  uint64_t totalBytes{0};
  uint32_t samples{0};
  uint32_t channels{0};
};

using OnStatus = std::function<void(const std::string& state)>;
using OnData   = std::function<void(const DataEvent&)>;

inline bool parse_packet_shape_filtered(const std::vector<uint8_t>& buf, uint32_t& samples, uint32_t& channels) {
  auto all_zero = [](const uint8_t* p, size_t n) {
    for (size_t i=0;i<n;++i) if (p[i]!=0) return false;
    return true;
  };
  if (buf.size() < 7) return false;
  if (buf[0]==0xFC && buf[1]==0xFA) { // EEG
    if (buf.size() <= 6) return false;
    size_t body = buf.size() - 6;
    if (body==0) return false;
    if (all_zero(buf.data()+6, body)) return false;
    samples  = static_cast<uint32_t>(body / 12); // 4ch × 3B
    channels = 4;
    return samples>0;
  } else if (buf[0]==0xFC && buf[1]==0xFB) { // ECG
    if (buf.size() <= 8) return false;
    size_t body = buf.size() - 8;
    if (body==0) return false;
    if (all_zero(buf.data()+8, body)) return false;
    samples  = static_cast<uint32_t>(body / 3);  // 1ch × 3B
    channels = 1;
    return samples>0;
  }
  return false;
}

class IBleRunner {
public:
  virtual ~IBleRunner() = default;
  virtual bool start(const BleOptions&, OnStatus, OnData) = 0;
  virtual void stop() = 0;
};
