#include <napi.h>
#include <atomic>
#include <thread>
#include <string>
#include <vector>
#include <chrono>
#include <cctype>
#include <memory>

#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Devices.Bluetooth.h>
#include <winrt/Windows.Devices.Bluetooth.Advertisement.h>
#include <winrt/Windows.Devices.Bluetooth.GenericAttributeProfile.h>
#include <winrt/Windows.Storage.Streams.h>

namespace wf    = winrt::Windows::Foundation;
namespace wfc   = winrt::Windows::Foundation::Collections;
namespace wfb   = winrt::Windows::Devices::Bluetooth;
namespace wfbad = winrt::Windows::Devices::Bluetooth::Advertisement;
namespace wfbga = winrt::Windows::Devices::Bluetooth::GenericAttributeProfile;
namespace wss   = winrt::Windows::Storage::Streams;
using namespace std::chrono_literals;

// ---------------- Utilities ----------------
static std::wstring ToWide(const std::string& s){ return std::wstring(s.begin(), s.end()); }
static std::string ToLower(std::string s){ for(auto& c:s) c=(char)std::tolower((unsigned char)c); return s; }
static bool StartsWithIgnoreCase(const std::string& s,const std::string& p){
  auto sl=ToLower(s), pl=ToLower(p); return pl.size()<=sl.size() && std::equal(pl.begin(),pl.end(),sl.begin());
}
static bool TryParseGuid(const std::string& s, winrt::guid& out){
  try{ out=winrt::guid(ToWide(s)); return true; }catch(...){ return false; }
}

// Find a characteristic by UUID; prefer searching inside preferred service first, then all services
static wfbga::GattCharacteristic FindCharByUuid(
  const wfb::BluetoothLEDevice& dev,
  const winrt::guid& uuid,
  const wfbga::GattDeviceService& preferred /* may be null */)
{
  try{
    if(preferred != nullptr){
      auto r = preferred.GetCharacteristicsForUuidAsync(uuid).get();
      if(r.Status()==wfbga::GattCommunicationStatus::Success && r.Characteristics().Size()>0)
        return r.Characteristics().GetAt(0);
    }
  }catch(...){}

  try{
    auto all = dev.GetGattServicesAsync().get();
    if(all.Status()!=wfbga::GattCommunicationStatus::Success) return {nullptr};
    auto svcs = all.Services();
    for(uint32_t i=0;i<svcs.Size();++i){
      auto s = svcs.GetAt(i);
      auto r = s.GetCharacteristicsForUuidAsync(uuid).get();
      if(r.Status()==wfbga::GattCommunicationStatus::Success && r.Characteristics().Size()>0)
        return r.Characteristics().GetAt(0);
    }
  }catch(...){}
  return {nullptr};
}

// Compose and write a command frame: [FD, FC] + [00,02] + [cmd] + [00]
static bool WriteCmdFrame(const wfbga::GattCharacteristic& ch, uint8_t hdrB /*0xFC EEG, 0xFD ECG*/, uint8_t cmd){
  try{
    if(ch == nullptr) return false;
    uint8_t frame[5] = { 0xFD, hdrB, 0x00, 0x02, cmd };
    std::vector<uint8_t> payload(frame, frame+5);
    payload.push_back(0x00);
    wss::DataWriter writer; writer.WriteBytes(payload); auto buf = writer.DetachBuffer();
    auto st = ch.WriteValueAsync(buf, wfbga::GattWriteOption::WriteWithoutResponse).get();
    if(st != wfbga::GattCommunicationStatus::Success){
      st = ch.WriteValueAsync(buf, wfbga::GattWriteOption::WriteWithResponse).get();
      if(st != wfbga::GattCommunicationStatus::Success) return false;
    }
    return true;
  }catch(...){ return false; }
}

// ---------------- Addon ----------------
class Addon : public Napi::ObjectWrap<Addon> {
public:
  explicit Addon(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<Addon>(info),
      running_(false), totalBytes_(0), channels_(0) {}

  ~Addon() override {
    try{ StopWorker(); }catch(...){}
    if(statusTsfn_) statusTsfn_.Release();
    if(dataTsfn_)   dataTsfn_.Release();
  }

  Napi::Value OnStatus(const Napi::CallbackInfo& info){
    Napi::Env env=info.Env();
    if(info.Length()<1 || !info[0].IsFunction())
      Napi::TypeError::New(env,"onStatus expects a function").ThrowAsJavaScriptException();
    if(statusTsfn_) statusTsfn_.Release();
    statusTsfn_ = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(), "statusTsfn", 64, 1);
    return env.Undefined();
  }
  Napi::Value OnData(const Napi::CallbackInfo& info){
    Napi::Env env=info.Env();
    if(info.Length()<1 || !info[0].IsFunction())
      Napi::TypeError::New(env,"onData expects a function").ThrowAsJavaScriptException();
    if(dataTsfn_) dataTsfn_.Release();
    dataTsfn_ = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(), "dataTsfn", 256, 1);
    return env.Undefined();
  }

  Napi::Value StartCapture(const Napi::CallbackInfo& info){
    Napi::Env env=info.Env();
    if(running_.load()){ PostStatus("already running"); return Napi::Boolean::New(env,true); }
    if(info.Length()<1 || !info[0].IsObject()){
      Napi::TypeError::New(env,"startCapture expects an options object").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    auto opts = info[0].As<Napi::Object>();
    namePrefix_ = GetStringOr(opts,"namePrefix","brain");
    serviceUUID_= GetStringOr(opts,"serviceUUID","");
    notifyUUID_ = GetStringOr(opts,"notifyUUID","ffee5343-0001-4ae5-8fa1-9fafd205e455");
    writeUUID_  = GetStringOr(opts,"writeUUID", "ffee5343-0001-4ae5-8fa2-9fafd205e455");
    mode_       = GetStringOr(opts,"mode","EEG");

    totalBytes_.store(0);
    channels_.store(0);
    running_.store(true);
    worker_ = std::thread(&Addon::WorkerProc,this);
    return Napi::Boolean::New(env,true);
  }

  Napi::Value StopCapture(const Napi::CallbackInfo& info){
    StopWorker();
    return info.Env().Undefined();
  }

  static Napi::Object Init(Napi::Env env, Napi::Object exports){
    Napi::Function ctor = DefineClass(env,"Addon",{
      InstanceMethod<&Addon::OnStatus>("onStatus"),
      InstanceMethod<&Addon::OnData>("onData"),
      InstanceMethod<&Addon::StartCapture>("startCapture"),
      InstanceMethod<&Addon::StopCapture>("stopCapture"),
    });
    exports.Set("Addon", ctor);
    return exports;
  }

private:
  void WorkerProc() noexcept {
    try{
      winrt::init_apartment(winrt::apartment_type::multi_threaded);
    }catch(...){
      PostStatus("init_apartment failed");
      running_.store(false);
      return;
    }

    try{
      if(!running_.load()) return;
      // 1) Scan
      PostStatus("scanning");
      wfbad::BluetoothLEAdvertisementWatcher watcher;
      watcher.ScanningMode(wfbad::BluetoothLEScanningMode::Active);

      std::atomic<bool> found{false};
      uint64_t addr=0;

      auto token = watcher.Received([&](wfbad::BluetoothLEAdvertisementWatcher const&,
                                        wfbad::BluetoothLEAdvertisementReceivedEventArgs const& args){
        try{
          auto name = winrt::to_string(args.Advertisement().LocalName());
          if(!namePrefix_.empty() && !name.empty() && StartsWithIgnoreCase(name,namePrefix_)){
            addr = args.BluetoothAddress(); found.store(true);
            try{ watcher.Stop(); }catch(...){}
          }
        }catch(...){}
      });
      try{ watcher.Start(); }catch(...){ PostStatus("watcher start failed"); }

      for(int i=0;i<200 && running_.load() && !found.load(); ++i) std::this_thread::sleep_for(100ms);
      try{ watcher.Stop(); }catch(...){}
      try{ watcher.Received(token); }catch(...){}

      if(!running_.load()){ PostStatus("stopped"); return; }
      if(!found.load()){ PostStatus("device not found"); return; }

      // 2) Connect
      PostStatus("connecting");
      wfb::BluetoothLEDevice dev = wfb::BluetoothLEDevice::FromBluetoothAddressAsync(addr).get();
      if(dev == nullptr){ PostStatus("device open failed"); return; }

      // 3) Service
      wfbga::GattDeviceService svc{nullptr};
      if(!serviceUUID_.empty()){
        winrt::guid sg{};
        if(!TryParseGuid(serviceUUID_,sg)){ PostStatus("invalid service UUID"); return; }
        auto r = dev.GetGattServicesForUuidAsync(sg).get();
        if(r.Status()!=wfbga::GattCommunicationStatus::Success || r.Services().Size()==0){
          PostStatus("service not found"); return;
        }
        svc = r.Services().GetAt(0);
      }else{
        auto r = dev.GetGattServicesAsync().get();
        if(r.Status()!=wfbga::GattCommunicationStatus::Success || r.Services().Size()==0){
          PostStatus("no services"); return;
        }
        svc = r.Services().GetAt(0);
      }

      // 4) Notify characteristic
      winrt::guid notifyGuid{};
      if(!TryParseGuid(notifyUUID_,notifyGuid)){ PostStatus("invalid notify UUID"); return; }
      wfbga::GattCharacteristic chNotify = FindCharByUuid(dev, notifyGuid, svc);
      if(chNotify == nullptr){ PostStatus("characteristic (notify) not found"); return; }
      auto st = chNotify.WriteClientCharacteristicConfigurationDescriptorAsync(
                  wfbga::GattClientCharacteristicConfigurationDescriptorValue::Notify).get();
      if(st != wfbga::GattCommunicationStatus::Success){ PostStatus("enable notify failed"); return; }

      // 5) Write/control characteristic
      winrt::guid writeGuid{};
      if(!TryParseGuid(writeUUID_, writeGuid)){ PostStatus("invalid write UUID"); return; }
      wfbga::GattCharacteristic chWrite = FindCharByUuid(dev, writeGuid, svc);
      if(chWrite == nullptr){ PostStatus("characteristic (write) not found"); return; }

      // 6) Subscribe notify
      PostStatus("subscribing");
      auto tokenChanged = chNotify.ValueChanged([&](wfbga::GattCharacteristic const& /*sender*/,
                                                    wfbga::GattValueChangedEventArgs const& e){
        try{
          wss::IBuffer ibuf = e.CharacteristicValue();
          const uint32_t n = ibuf.Length();
          std::vector<uint8_t> bytes;
          if(n>0){ auto rd=wss::DataReader::FromBuffer(ibuf); bytes.resize(n); rd.ReadBytes(bytes); }

          totalBytes_.fetch_add(n, std::memory_order_relaxed);

          uint32_t samples=0, chans=channels_.load(std::memory_order_relaxed);
          std::string typ = "unknown";
          if(bytes.size()>=2 && bytes[0]==0xFC && bytes[1]==0xFA){
            size_t body = n>6 ? (n-6) : 0; samples = (uint32_t)(body/12); chans=4; channels_.store(4); typ="EEG";
          }else if(bytes.size()>=2 && bytes[0]==0xFC && bytes[1]==0xFB){
            size_t body = n>8 ? (n-8) : 0; samples = (uint32_t)(body/3);  chans=1; channels_.store(1); typ="ECG";
          }

          if(dataTsfn_){
            struct P{
              uint32_t last;
              double   total;
              uint32_t samples;
              uint32_t chans;
              std::shared_ptr<std::vector<uint8_t>> pbytes;
              std::string typ;
            };
            auto p = new P{ n, (double)totalBytes_.load(), samples, chans,
                            std::make_shared<std::vector<uint8_t>>(bytes.begin(), bytes.end()),
                            typ };
            auto call=[](Napi::Env env, Napi::Function cb, P* q){
              Napi::Object o=Napi::Object::New(env);
              o.Set("lastPacketBytes", Napi::Number::New(env,q->last));
              o.Set("totalBytes",      Napi::Number::New(env,q->total));
              o.Set("samples",         Napi::Number::New(env,q->samples));
              o.Set("channels",        Napi::Number::New(env,q->chans));
              o.Set("type",            Napi::String::New(env, q->typ));
              if(q->pbytes && !q->pbytes->empty()){
                auto buf = Napi::Buffer<uint8_t>::Copy(env, q->pbytes->data(), q->pbytes->size());
                o.Set("raw", buf);
              }
              cb.Call({o}); delete q;
            };
            (void)dataTsfn_.BlockingCall(p,call);
          }
        }catch(...){}
      });

      // 7) Send reset -> start
      const uint8_t hdrB = (ToLower(mode_)=="ecg") ? 0xFD : 0xFC;
      PostStatus("sending reset");
      (void)WriteCmdFrame(chWrite, hdrB, 0x00); // reset
      std::this_thread::sleep_for(50ms);
      PostStatus("sending start");
      if(!WriteCmdFrame(chWrite, hdrB, 0x01)){
        PostStatus("start command failed");
      }else{
        PostStatus("collecting");
      }

      // 8) Wait until stopped
      while(running_.load()) std::this_thread::sleep_for(100ms);

      // 9) Send reset on stop
      PostStatus("sending stop");
      (void)WriteCmdFrame(chWrite, hdrB, 0x00);

      // 10) Unsubscribe & disable CCCD
      try{ chNotify.ValueChanged(tokenChanged); }catch(...){}
      try{
        chNotify.WriteClientCharacteristicConfigurationDescriptorAsync(
          wfbga::GattClientCharacteristicConfigurationDescriptorValue::None).get();
      }catch(...){}

      try{ svc.Close(); }catch(...){}
      try{ dev.Close(); }catch(...){}
      PostStatus("stopped");
    }catch(...){
      PostStatus("worker exception");
    }
  }

  void StopWorker(){
    bool was = running_.exchange(false);
    if(!was) return;
    if(worker_.joinable()){ try{ worker_.join(); }catch(...){ } }
  }

  static std::string GetStringOr(Napi::Object o,const char* k,const std::string& d){
    auto v=o.Get(k); return v.IsString()? v.As<Napi::String>().Utf8Value() : d;
  }
  void PostStatus(const std::string& s){
    if(!statusTsfn_) return;
    auto* msg=new std::string(s);
    auto call=[](Napi::Env env, Napi::Function cb, std::string* p){
      cb.Call({ Napi::String::New(env,*p) }); delete p;
    };
    (void)statusTsfn_.BlockingCall(msg,call);
  }

private:
  Napi::ThreadSafeFunction statusTsfn_;
  Napi::ThreadSafeFunction dataTsfn_;
  std::thread worker_;
  std::atomic<bool> running_;
  std::atomic<uint64_t> totalBytes_;
  std::atomic<uint32_t> channels_;

  std::string namePrefix_;
  std::string serviceUUID_;
  std::string notifyUUID_;
  std::string writeUUID_;
  std::string mode_; // EEG|ECG
};

Napi::Object InitAll(Napi::Env env, Napi::Object exports){ return Addon::Init(env, exports); }
NODE_API_MODULE(ble_capture, InitAll)
