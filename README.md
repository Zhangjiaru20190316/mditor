# Mditor

[![平台](https://img.shields.io/badge/platform-Windows-blue)](https://github.com/Zhangjiaru20190316/mditor/releases) [![许可](https://img.shields.io/badge/license-MIT-green)](LICENSE) [![GitHub 下载](https://img.shields.io/github/downloads/Zhangjiaru20190316/mditor/total?label=downloads&color=success)](https://github.com/Zhangjiaru20190316/mditor/releases/latest)

**本地优先的 Markdown 编辑器，体验对标 Typora。** 免费、开源、无遥测、无广告——文件默认只保存在你自己的电脑上；如需多设备同步，可选自带 S3 云同步（默认关闭，见项目文档）。

- **官网 / 下载**：https://Zhangjiaru20190316.github.io/mditor/
- **最新版本**：v5.0.1-beta（[下载安装包](https://github.com/Zhangjiaru20190316/mditor/releases/latest)）
- **项目文档**：[mditor/README.md](mditor/README.md)（功能特性、开发指南、安全模型）

## 项目结构

```
├── mditor/          # 应用本体（Tauri 2 + React + Milkdown，Windows + HarmonyOS PC）
│   └── docs/        # 项目文档（性能治理索引、安全说明、发版 runbook 等）
├── docs/            # 仓库级治理文档（任务书、归档报告）
├── site/            # 官网静态页面（GitHub Pages）
└── .github/         # CI（发布流水线 + 官网部署）
```

## License

[MIT](LICENSE) © 2026 Mditor contributors