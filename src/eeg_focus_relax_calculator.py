# """
# EEG Mental State Analysis
# 功能：基于脑电信号计算专注度和放松度指标
# 作者：Zhang Xingjian
# 日期：20250910
# """


# def eeg_analysis(
#         eeg_data,
#         eogl_data,
#         eogr_data,
#         m1_data,
#         sfreq=250,
#         lowcut=1,
#         highcut=45,
#         notch_freq=50,
#         nperseg=512,
#         overlap=0.5,
#         base_score_focus=10,
#         base_score_relax=10,
#         K_focus=1.0,
#         K_relax=1.0,
#         K_eeg=0.8):
#     """
#     基于脑电信号计算专注度和放松度指标

#     :param eeg_data: EEG通道原始数据 (numpy数组)
#     :param eogl_data: EOG左眼通道原始数据 (numpy数组)
#     :param eogr_data: EOG右眼通道原始数据 (numpy数组)
#     :param m1_data: M1参考通道原始数据 (numpy数组)
#     :param sfreq: 采样频率，默认为250Hz
#     :param lowcut: 带通滤波下限频率(Hz)
#     :param highcut: 带通滤波上限频率(Hz)
#     :param notch_freq: 陷波滤波中心频率(Hz)
#     :param nperseg: Welch方法分段长度
#     :param overlap: Welch方法重叠比例(0-1)
#     :param base_score_focus: 专注度基础分数(0-100)
#     :param base_score_relax: 放松度基础分数(0-100)
#     :param K_focus: 专注度调整系数
#     :param K_relax: 放松度调整系数
#     :param K_eeg: EEG通道权重(0-1)

#     :return: 返回元组包含以下内容:
#              - gamma_ratio: γ频段(30-45Hz)能量占比
#              - beta_ratio: β频段(14-30Hz)能量占比
#              - alpha_ratio: α频段(8-14Hz)能量占比
#              - theta_ratio: θ频段(4-8Hz)能量占比
#              - delta_ratio: δ频段(0.5-4Hz)能量占比
#              - focus_score: 专注度评分(0-100)
#              - relax_score: 放松度评分(0-100)
#     """

#     from scipy import signal, integrate

#     def filter_data(data, sfreq, lowcut, highcut, notch_freq):
#         """对单通道数据进行带通滤波和陷波滤波"""
#         N = 4   # 阶数
#         Q = 30  # 陷波因子
#         # 带通滤波
#         nyquist = 0.5 * sfreq
#         low = lowcut / nyquist
#         high = highcut / nyquist
#         b, a = signal.butter(N, [low, high], btype='band')
#         filtered = signal.filtfilt(b, a, data)
#         # 陷波滤波
#         b_notch, a_notch = signal.iirnotch(notch_freq, Q, sfreq)
#         filtered = signal.filtfilt(b_notch, a_notch, filtered)
#         return filtered


#     def compute_band_ratios(data, sfreq, nperseg, overlap):
#         """计算脑电信号在五个主要频段的能量比值"""
#         # 定义频段范围
#         bands = {
#             'gamma': (30, 45),  # γ波
#             'beta': (14, 30),  # β波
#             'alpha': (8, 14),  # α波
#             'theta': (4, 8),  # θ波
#             'delta': (0.5, 4)  # δ波
#         }

#         # 计算功率谱密度 (PSD) - 使用Welch方法
#         f, Pxx = signal.welch(
#             data,
#             fs=sfreq,
#             nperseg=nperseg,
#             noverlap=int(overlap * nperseg),  # 计算重叠点数
#             window='hann'
#         )

#         # 计算总功率（0.5-45Hz范围内）
#         freq_range_mask = (f >= 0.5) & (f <= 45)
#         total_power = integrate.trapezoid(Pxx[freq_range_mask], f[freq_range_mask])

#         # 计算各频段功率
#         band_powers = {}
#         for band, (low, high) in bands.items():
#             idx = (f >= low) & (f <= high)
#             band_power = integrate.trapezoid(Pxx[idx], f[idx])
#             band_powers[band] = band_power / total_power  # 计算比值

#         return band_powers


#     # 确保所有通道数据长度一致
#     assert len(eeg_data) == len(eogl_data) == len(eogr_data) == len(m1_data), "所有通道数据长度必须一致"

#     # 执行重参考（减去M1通道数据）
#     eeg_m1 = eeg_data - m1_data
#     eogl_m1 = eogl_data - m1_data
#     eogr_m1 = eogr_data - m1_data

#     # 滤波
#     eeg_m1_filtered = filter_data(eeg_m1, sfreq, lowcut, highcut, notch_freq)
#     eogl_m1_filtered = filter_data(eogl_m1, sfreq, lowcut, highcut, notch_freq)
#     eogr_m1_filtered = filter_data(eogr_m1, sfreq, lowcut, highcut, notch_freq)

#     # 计算各通道的频段能量比值
#     eeg_ratios = compute_band_ratios(eeg_m1_filtered, sfreq, nperseg, overlap)
#     eogl_ratios = compute_band_ratios(eogl_m1_filtered, sfreq, nperseg, overlap)
#     eogr_ratios = compute_band_ratios(eogr_m1_filtered, sfreq, nperseg, overlap)

#     # 加权融合各通道的频段能量比值
#     fused_ratios = {}
#     bands = ['gamma', 'beta', 'alpha', 'theta', 'delta']
#     for band in bands:
#         fused_value = (
#             K_eeg * eeg_ratios[band] +
#             (1 - K_eeg) / 2 * eogl_ratios[band] +
#             (1 - K_eeg) / 2 * eogr_ratios[band]
#         )
#         fused_ratios[band] = fused_value

#     # 确保比值之和为1（归一化处理）
#     total = sum(fused_ratios.values())
#     if abs(total - 1.0) > 1e-5:
#         for band in fused_ratios:
#             fused_ratios[band] /= total

#     # 计算专注度和放松度指标
#     relax_score = fused_ratios['alpha'] / (fused_ratios['theta'] + fused_ratios['alpha'] + fused_ratios['beta'])
#     focus_score = fused_ratios['beta'] / (fused_ratios['alpha'] + fused_ratios['theta'])

#     # 换为百分制与增加基础分
#     relax_score = relax_score * 100 * K_relax + base_score_relax
#     focus_score = focus_score * 100 * K_focus + base_score_focus

#     if focus_score > 100:
#         focus_score = 100
#     if relax_score > 100:
#         relax_score = 100

#     # 使用经验公式映射专注度
#     # k = 2.0  # 调整此参数控制增长速率
#     # focus_mapped = 100 * (1 - np.exp(-k * focus_score))

#     # 返回五个频段比值及专注度、放松度
#     return (
#         fused_ratios['gamma'],
#         fused_ratios['beta'],
#         fused_ratios['alpha'],
#         fused_ratios['theta'],
#         fused_ratios['delta'],
#         focus_score,
#         relax_score
#     )


# def plot_eeg_waveforms(time_points, gamma_values, beta_values, alpha_values, theta_values, delta_values,
#                        focus_scores=None, relax_scores=None, title="脑电各频段能量分布"):
#     """
#     绘制类似参考图片的多层波形图

#     :param time_points: 时间点列表
#     :param gamma_values: γ波能量值列表
#     :param beta_values: β波能量值列表
#     :param alpha_values: α波能量值列表
#     :param theta_values: θ波能量值列表
#     :param delta_values: δ波能量值列表
#     :param focus_scores: 专注度分数列表（可选）
#     :param relax_scores: 放松度分数列表（可选）
#     :param title: 图表标题
#     """
#     import matplotlib
#     matplotlib.use('TkAgg')  # 使用TkAgg后端
#     import matplotlib.pyplot as plt
#     import numpy as np

#     # 设置中文字体
#     plt.rcParams['font.sans-serif'] = ['SimHei']
#     plt.rcParams['axes.unicode_minus'] = False

#     # 创建画布
#     fig = plt.figure(figsize=(14, 10))

#     # 1. 主图：多层波形堆叠图（模仿参考图片样式）
#     ax1 = plt.subplot2grid((3, 1), (0, 0), rowspan=2)

#     # 定义颜色（参考图片中的颜色）
#     colors = ['#FF9999', '#66B2FF', '#FFD700', '#99FF99', '#CC99FF']  # 粉、蓝、黄、绿、紫

#     # 计算堆叠位置（从下往上堆叠）
#     stacked_gamma = np.array(gamma_values)
#     stacked_beta = stacked_gamma + np.array(beta_values)
#     stacked_alpha = stacked_beta + np.array(alpha_values)
#     stacked_theta = stacked_alpha + np.array(theta_values)
#     stacked_delta = stacked_theta + np.array(delta_values)

#     # 绘制多层波形填充区域
#     ax1.fill_between(time_points, 0, delta_values, color=colors[4], alpha=0.8, label='δ波 (0.5-4Hz)')
#     ax1.fill_between(time_points, delta_values, stacked_theta, color=colors[3], alpha=0.8, label='θ波 (4-8Hz)')
#     ax1.fill_between(time_points, stacked_theta, stacked_alpha, color=colors[2], alpha=0.8, label='α波 (8-14Hz)')
#     ax1.fill_between(time_points, stacked_alpha, stacked_beta, color=colors[1], alpha=0.8, label='β波 (14-30Hz)')
#     ax1.fill_between(time_points, stacked_beta, stacked_gamma, color=colors[0], alpha=0.8, label='γ波 (30-45Hz)')

#     # 设置主图属性
#     ax1.set_title(title, fontsize=16, fontweight='bold', pad=20)
#     ax1.set_ylabel('能量比例', fontsize=12)
#     ax1.grid(True, alpha=0.3, linestyle='--')
#     ax1.legend(loc='upper right', bbox_to_anchor=(1.15, 1))
#     ax1.set_xlim(min(time_points), max(time_points))

#     # 2. 如果有专注度和放松度数据，绘制在下方
#     if focus_scores is not None and relax_scores is not None:
#         ax2 = plt.subplot2grid((3, 1), (2, 0))

#         # 绘制专注度和放松度曲线
#         ax2.plot(time_points, focus_scores, 'r-', linewidth=2, label='专注度')
#         ax2.plot(time_points, relax_scores, 'b-', linewidth=2, label='放松度')

#         # 填充区域
#         ax2.fill_between(time_points, focus_scores, alpha=0.3, color='red')
#         ax2.fill_between(time_points, relax_scores, alpha=0.3, color='blue')

#         ax2.set_xlabel('时间 (秒)', fontsize=12)
#         ax2.set_ylabel('心理状态评分', fontsize=12)
#         ax2.set_ylim(0, 100)
#         ax2.grid(True, alpha=0.3)
#         ax2.legend()

#     plt.tight_layout()

#     plt.show()
#     return fig


# def get_eeg_data(edf_path, start_time=30, duration=5):
#     """
#     从本地EDF文件加载数据并返回四个通道的脑电数据

#     :param edf_path: 本地edf数据路径
#     :param start_time: 开始时间（秒）
#     :param duration: 持续时间（秒）
#     :return: 返回脑电数据（四个通道分别返回）
#             返回格式: (eeg_data, eog_l_data, eog_r_data, m1_data)
#     """

#     import mne

#     # 读取EDF文件
#     raw = mne.io.read_raw_edf(edf_path, preload=True)
#     sfreq = raw.info['sfreq']  # 采样率

#     # 检查文件时长是否足够
#     if raw.times[-1] < 65:  # 检查是否有65秒数据
#         raise ValueError(f"EDF文件时长不足65秒，实际时长: {raw.times[-1]:.2f}秒")

#     # 选择指定通道
#     selected_chs = ['EEG', 'EOG-L', 'EOG-R', 'M1']
#     raw.pick_channels(selected_chs)

#     # 提取数据
#     start_sample = int(start_time * sfreq)
#     end_sample = start_sample + int(duration * sfreq)

#     # 获取各通道数据
#     eeg_data = raw.get_data(picks='EEG', start=start_sample, stop=end_sample).flatten()
#     eog_l_data = raw.get_data(picks='EOG-L', start=start_sample, stop=end_sample).flatten()
#     eog_r_data = raw.get_data(picks='EOG-R', start=start_sample, stop=end_sample).flatten()
#     m1_data = raw.get_data(picks='M1', start=start_sample, stop=end_sample).flatten()

#     # 打印信息
#     print(f"采样率: {sfreq}Hz")
#     print(f"提取数据: {start_time}-{start_time + duration}秒")

#     return eeg_data, eog_l_data, eog_r_data, m1_data



# if __name__ == "__main__":
#     edf_file = "../data/mdsk_test01.edf"
#     sfreq = 250

#     # 从本地文件获取数据
#     eeg, eogL, eogR, m1 = get_eeg_data(edf_file, start_time=700, duration=1400)

#     # 初始化存储结果的列表
#     time_points = []
#     gamma_values = []
#     beta_values = []
#     alpha_values = []
#     theta_values = []
#     delta_values = []
#     focus_scores = []
#     relax_scores = []

#     # 分析参数
#     window_size = 5  # 每次分析5秒数据
#     step_size = 5  # 每5秒移动一次窗口
#     total_duration = 700  # 10分钟=600秒

#     # 分段分析数据
#     for start in range(0, total_duration - window_size + 1, step_size):
#         end = start + window_size
#         print(f"\n分析时间段: {start}-{end}秒")

#         # 计算当前段的样本索引
#         start_sample = int(start * sfreq)
#         end_sample = int(end * sfreq)

#         # 提取当前段数据
#         eeg_segment = eeg[start_sample:end_sample]
#         eogL_segment = eogL[start_sample:end_sample]
#         eogR_segment = eogR[start_sample:end_sample]
#         m1_segment = m1[start_sample:end_sample]

#         # 分析当前段数据
#         gamma, beta, alpha, theta, delta, focus, relax = eeg_analysis(
#             eeg_data=eeg_segment,
#             eogl_data=eogL_segment,
#             eogr_data=eogR_segment,
#             m1_data=m1_segment,
#             sfreq=sfreq
#         )

#         # 存储结果
#         time_points.append(start + window_size / 2)  # 取时间窗口的中点作为时间戳
#         gamma_values.append(gamma)
#         beta_values.append(beta)
#         alpha_values.append(alpha)
#         theta_values.append(theta)
#         delta_values.append(delta)
#         focus_scores.append(focus)
#         relax_scores.append(relax)

#     # 使用抽象的函数绘制图表
#     print("\n开始绘制图表...")

#     # 绘制综合图表（包含能量分布和心理状态）
#     fig = plot_eeg_waveforms(time_points, gamma_values, beta_values, alpha_values,
#                               theta_values, delta_values, focus_scores, relax_scores,
#                               title="脑电各频段能量分布与心理状态")

"""
EEG Mental State Analysis
功能：基于脑电信号计算专注度和放松度指标
作者：Zhang Xingjian
日期：20250910
"""

import sys, json
import numpy as np
from scipy import signal, integrate

def eeg_analysis(
        eeg_data,
        eogl_data,
        eogr_data,
        m1_data,
        sfreq=250,
        lowcut=1,
        highcut=45,
        notch_freq=50,
        nperseg=512,
        overlap=0.5,
        base_score_focus=10,
        base_score_relax=10,
        K_focus=1.0,
        K_relax=1.0,
        K_eeg=0.8):
    """
    返回:
      gamma_ratio, beta_ratio, alpha_ratio, theta_ratio, delta_ratio, focus_score, relax_score
    """

    def filter_data(data, sfreq, lowcut, highcut, notch_freq):
        N = 4
        Q = 30
        nyquist = 0.5 * sfreq
        low = lowcut / nyquist
        high = highcut / nyquist
        b, a = signal.butter(N, [low, high], btype='band')
        filtered = signal.filtfilt(b, a, data)
        b_notch, a_notch = signal.iirnotch(notch_freq, Q, sfreq)
        filtered = signal.filtfilt(b_notch, a_notch, filtered)
        return filtered

    def compute_band_ratios(data, sfreq, nperseg, overlap):
        bands = {
            'gamma': (30, 45),
            'beta':  (14, 30),
            'alpha': (8, 14),
            'theta': (4, 8),
            'delta': (0.5, 4)
        }
        f, Pxx = signal.welch(
            data,
            fs=sfreq,
            nperseg=nperseg,
            noverlap=int(overlap * nperseg),
            window='hann'
        )
        freq_range_mask = (f >= 0.5) & (f <= 45)
        total_power = integrate.trapezoid(Pxx[freq_range_mask], f[freq_range_mask])
        if total_power <= 0:
            total_power = 1e-12

        band_powers = {}
        for band, (low, high) in bands.items():
            idx = (f >= low) & (f <= high)
            band_power = integrate.trapezoid(Pxx[idx], f[idx])
            band_powers[band] = band_power / total_power
        return band_powers

    assert len(eeg_data) == len(eogl_data) == len(eogr_data) == len(m1_data), "所有通道数据长度必须一致"

    eeg_m1  = np.asarray(eeg_data)  - np.asarray(m1_data)
    eogl_m1 = np.asarray(eogl_data) - np.asarray(m1_data)
    eogr_m1 = np.asarray(eogr_data) - np.asarray(m1_data)

    eeg_f  = filter_data(eeg_m1,  sfreq, lowcut, highcut, notch_freq)
    eogl_f = filter_data(eogl_m1, sfreq, lowcut, highcut, notch_freq)
    eogr_f = filter_data(eogr_m1, sfreq, lowcut, highcut, notch_freq)

    eeg_rat  = compute_band_ratios(eeg_f,  sfreq, nperseg, overlap)
    eogl_rat = compute_band_ratios(eogl_f, sfreq, nperseg, overlap)
    eogr_rat = compute_band_ratios(eogr_f, sfreq, nperseg, overlap)

    fused = {}
    for band in ['gamma','beta','alpha','theta','delta']:
        fused[band] = K_eeg*eeg_rat[band] + (1-K_eeg)/2*eogl_rat[band] + (1-K_eeg)/2*eogr_rat[band]
    s = sum(fused.values())
    if abs(s-1.0) > 1e-6:
        for k in list(fused.keys()):
            fused[k] /= (s if s>0 else 1e-12)

    relax = fused['alpha'] / (fused['theta'] + fused['alpha'] + fused['beta'])
    focus = fused['beta']  / (fused['alpha'] + fused['theta'])

    relax = relax * 100 * 1.0 + base_score_relax
    focus = focus * 100 * 1.0 + base_score_focus

    if focus > 100: focus = 100
    if relax > 100: relax = 100

    return (
        float(fused['gamma']),
        float(fused['beta']),
        float(fused['alpha']),
        float(fused['theta']),
        float(fused['delta']),
        float(focus),
        float(relax)
    )

# ---- JSONL 服务：与 Electron 主进程交互 ----
def _print(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

if __name__ == "__main__":
    _print({"type":"ready"})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            if req.get("cmd") == "compute":
                eeg  = req["eeg"]
                eogl = req["eogl"]
                eogr = req["eogr"]
                m1   = req["m1"]
                sf   = int(req.get("sfreq", 250))
                g,b,a,t,d,focus,relax = eeg_analysis(
                    eeg_data=eeg, eogl_data=eogl, eogr_data=eogr, m1_data=m1, sfreq=sf
                )
                _print({"type":"result","payload":{
                    "gamma":g, "beta":b, "alpha":a, "theta":t, "delta":d,
                    "focus":focus, "relax":relax
                }})
        except Exception as e:
            _print({"type":"error","err":str(e)})
