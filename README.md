# 阅读 NG 资源仓库

为阅读 NG 集中维护字体、阅读背景、TTS 脚本和主题。开发者提交资源文件及说明，工具自动生成分类索引、文件校验信息和更新版本。

所有资源统一放在 `resources/` 下，根目录只保留仓库配置、文档、工具和测试：

```text
resources/
├── fonts/
├── backgrounds/
├── tts/
└── themes/
```

当前提供四类最小示例，以及目录工具、回归测试和 GitHub Actions。TTS 示例是默认禁用、需要自行配置服务的接口模板，本机原有的服务脚本与资料不在仓库中。NG 内资源中心尚未接入；云端执行记录见 [Actions](https://github.com/joestar817/legado-resources/actions)。

## 目录

| 目录 | 内容 |
|---|---|
| `resources/fonts/` | TTF / OTF 字体 |
| `resources/backgrounds/` | PNG / JPEG / WebP 阅读背景 |
| `resources/tts/` | NG JS 朗读引擎分类，当前为接口模板示例 |
| `resources/themes/` | NG 主题包或对应导入器支持的 ZIP |
| `tools/` | 索引生成与发布工具 |
| `test/` | 使用临时目录和本地 Git 远端的回归测试 |

四个示例：

- [Noto Sans 字体](resources/fonts/noto-sans-example/README.md)：保留上游原始字节与 OFL 许可；不包含中文字形。
- [暖纸阅读背景](resources/backgrounds/warm-paper-example/README.md)：1080×1440 原创 PNG。
- [HTTP TTS 模板](resources/tts/http-template-example/README.md)：展示脚本接口，不绑定在线服务。
- [暖纸 NG 主题](resources/themes/warm-paper-example/README.md)：包含日夜配色的原生主题包。

工具回归使用隔离临时夹具，示例检查只读取上述公开示例，不依赖未提交的本地 TTS 文件。目录检查通过不代表资源已经在 NG 实机验收。

## 本地验证

需要 Node.js 22 或更新版本；Git 发布测试还需要 Git。没有第三方运行依赖，不需要先执行 `npm install`。

在仓库根目录执行，PowerShell、WSL 或 Linux 均可使用以下命令，前提是该环境已安装 Node.js 和 Git：

```text
node tools/catalog.mjs validate --root .
node --test test/*.test.mjs
```

当前测试共 78 项。Windows 上无法创建文件符号链接时，相关两项会明确跳过；其它平台应以实际测试输出为准。背景与主题可使用 Python 3 标准库命令 `python3 tools/build-example-assets.py` 确定性重建，无需第三方图像库。

## 自动维护方式

1. 作者在资源目录提交文件和对应的 `*.resource.json`；TTS 名称、作者及作者版本可从已有脚本头部提取。
2. PR 检查使用目标分支中的可信生成器读取候选资源，只做检查，不执行投稿脚本或发布索引。
3. 首次建立云端仓库时，手动运行一次“更新资源目录”，勾选 `bootstrap` 初始化目录；之后 `main` 接收获准提交时，Actions 自动测试、生成索引并更新 `catalog` 分支。
4. NG 客户端将来固定一次 `catalog` 提交读取索引，再按 `sourceCommit` 下载源文件。客户端无需遍历仓库，也不依赖 Releases。

生成目录包括总目录 `catalog.json`、各分类的 `index.json` 和内部版本台账 `state.json`。开发者不手改这些文件，不把它们提交到 `main`。

新资源版本为 1；安装内容变化才递增。改介绍、移动源文件或重复运行不升版。删除后保留台账，重新加入同 ID 不重置版本。生成失败保留上次目录；旧任务不能覆盖已发布的新来源。目录分支丢失时普通任务会停止，不会自动重建为版本 1；只有首次初始化才使用 `bootstrap`。详见 [目录协议](docs/CATALOG_PROTOCOL.md)。

## 新增与更新资源

投稿步骤、字段与例子见 [贡献说明](CONTRIBUTING.md)。源文件存储在普通 Git 中；需要 LFS 时再单独配置。工具遇到尚未展开的 LFS 指针会拒绝生成，正式索引必须描述真实文件。

资源作者、授权和服务状态应填写真实来源信息。工具接受 `NOASSERTION` 以表示尚未声明许可；该值不代表已经确认再分发许可，也不授予第三方服务账号或声音的使用权限。

## 发布与验收范围

本地测试覆盖目录、版本和 Git 发布行为，不代表实际 GitHub Actions、分支规则、访问凭据、网络分发或 NG 客户端已经验证。工作流推送后，还需要在真实 GitHub 仓库完成首次目录初始化、PR 检查和自动发布验证。

根目录的 `catalog.config.json` 描述 `resources/` 下四个受支持分类，分类 ID 保持不变。生成器只读取该目录中的资源说明；新增任意目录不会自动赋予 NG 一种新安装能力，NG 仍需要对应的类型适配器。
