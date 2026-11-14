# 阅读 NG 资源仓库

为阅读 NG 集中维护资源，按“用途 → 资源类型”浏览。开发者提交资源文件及说明，工具自动生成用途分类、文件校验信息和更新版本。

| 一级用途 | 当前资源类型 | 稳定分类 ID |
|---|---|---|
| 阅读 | 阅读预设包 | `read-presets` |
| 外观 | 主题包 | `themes` |
| 听书 | TTS 脚本 | `tts` |
| 宠物 | 编译宠物插件 | `pets` |

阅读预设包可包含背景、字体、排版和浮窗配色，下载后加入阅读预设列表，由用户选择使用。独立字体和背景不再提供在线分发；历史文件保留，不影响本地已有资源。动态场景、本地 TTS 引擎等类型需接入对应适配器后再上架。

资源中心的安装包放在 `resources/` 下，供作者下载的工具包按版本放在 `sdk/` 下。

```text
resources/
├── read-presets/
├── tts/
├── themes/
└── pets/
```

当前包含三款阅读预设、咕嘎和蓝色大肥鱼，以及 TTS 和主题资源，同时提供目录工具、回归测试和 GitHub Actions。TTS 示例是默认禁用、需要自行配置服务的接口模板。云端执行记录见 [Actions](https://github.com/joestar817/legado-resources/actions)。

## 目录

| 目录 | 内容 |
|---|---|
| `resources/read-presets/` | 阅读预设 ZIP、资源说明与预览图 |
| `resources/fonts/`、`resources/backgrounds/` | 保留的历史资源，不再加入目录 |
| `resources/tts/` | 听书下的 TTS 脚本，当前为接口模板示例 |
| `resources/themes/` | 外观下的 NG 主题包或对应导入器支持的 ZIP |
| `resources/pets/` | 含 DEX 和清单的宠物 ZIP 插件 |
| `sdk/pet/` | 提供给作者的版本化宠物开发 SDK |
| `tools/` | 索引生成与发布工具 |
| `test/` | 使用临时目录和本地 Git 远端的回归测试 |

资源与示例：

- [敦煌绮笺](resources/read-presets/dunhuang-letter/preset.resource.json)、[江湖驿书](resources/read-presets/jianghu-letter/preset.resource.json)和[星河秘笺](resources/read-presets/starry-letter/preset.resource.json)：包含背景、字体及阅读样式的预设包。
- [HTTP TTS 模板](resources/tts/http-template-example/README.md)：展示脚本接口，不绑定在线服务。
- [暖纸 NG 主题](resources/themes/warm-paper-example/README.md)：包含日夜配色的原生主题包。

工具回归使用隔离临时夹具，资产检查只读取上述资源与示例，不依赖未提交的本地 TTS 文件。目录检查通过不代表资源已经在 NG 实机验收。

## 本地验证

目录校验与 Node 测试需要 Node.js 22 或更新版本；Git 发布测试还需要 Git。没有第三方 Node 运行依赖，不需要先执行 `npm install`。字体样张生成另需 Python 3.10，以及 `tools/font-preview-requirements.txt` 中固定版本的 Pillow 和 fontTools；Pillow 必须支持 RAQM。

在仓库根目录执行，PowerShell、WSL 或 Linux 均可使用以下命令，前提是该环境已安装 Node.js 和 Git：

```text
node tools/catalog.mjs validate --root .
node --test test/*.test.mjs
```

测试覆盖目录、发布与字体预览，具体数量以运行输出为准。Windows 上无法创建文件符号链接时，相关测试会明确跳过；其它平台应以实际测试输出为准。背景与主题可使用 Python 3 标准库命令 `python3 tools/build-example-assets.py` 确定性重建，无需第三方图像库。

生成字体样张前安装固定依赖，并可单独执行字体渲染测试：

```text
python3 -m pip install --only-binary=:all: -r tools/font-preview-requirements.txt
python3 -B test/font-preview.test.py
```

发布工作流固定 Python 3.10 和依赖版本。自定义 Python 路径可通过 `FONT_PREVIEW_PYTHON` 指定；普通 `validate` 与 PR 投稿校验不会启动字体渲染器。

## 自动维护方式

1. 作者在资源目录提交文件和对应的 `*.resource.json`；TTS 名称、作者及作者版本可从已有脚本头部提取。
2. PR 检查使用目标分支中的可信生成器读取候选资源，只做检查，不执行投稿脚本或发布索引。
3. 首次建立云端仓库时，手动运行一次“更新资源目录”，勾选 `bootstrap` 初始化目录；之后 `main` 接收获准提交时，Actions 自动测试、生成索引并更新 `catalog` 分支。
4. 发布器优先使用资源名称前两个可见字符生成方形缩略图，例如“风云体”显示“风云”；字符必须由源字体真实支持，缺字时改用该字体已有的样字。详情使用固定的中文、英文、数字标点样例，源字体缺字时用仓库固定补字字体混排。图片随索引一并发布，不需要作者手动截图或维护预览字段。
5. NG 客户端固定一次 `catalog` 提交读取索引和预览图，再按 `sourceCommit` 下载源文件。客户端无需遍历仓库，也不依赖 Releases。

目录同时自动记录每项资源的 `publishedAt`（首次收录）和 `updatedAt`（最近一次安装内容变更），统一保存为 UTC 时间。取值来自对应受信源提交的提交时间，不使用文件修改时间或任务运行时间。只改说明、移动文件或重复发布不会刷新日期。

已有目录若缺日期，普通发布会明确停止。仓库维护者需在“更新资源目录”的手动运行中勾选 `initialize_dates` 一次（不要同时勾选 `bootstrap`），或使用 `node tools/publish-catalog.mjs --root . --initialize-dates`。工具按完整 catalog 历史恢复日期并保留版本与指纹；历史缺失、分叉、时间倒退或日期不一致时拒绝猜测。首次新建目录会直接记录日期，无需初始化日期。

生成目录包括总目录 `catalog.json`、各分类的 `index.json`、内部版本台账 `state.json`，以及 `previews/` 下按图片 SHA256 命名的字体与宠物预览 PNG。开发者不手改这些文件，不把它们提交到 `main`；每项字体的源目录仍只需字体文件与元数据。

`preview` 是索引中的机器字段，不能写进投稿元数据。宠物和阅读预设可通过 `previewSource` 提供预览图，详情见[目录协议](docs/CATALOG_PROTOCOL.md#宠物与阅读预设的预览)。仅更换预览不会增加安装版本，也不修改资源的发布时间或内容更新时间。预览校验失败会停止本次发布，保留上次可用目录。

新资源版本为 1；安装内容变化才递增。改介绍、移动源文件或重复运行不升版。删除后保留台账，重新加入同 ID 不重置版本。生成失败保留上次目录；旧任务不能覆盖已发布的新来源。目录分支丢失时普通任务会停止，不会自动重建为版本 1；只有首次初始化才使用 `bootstrap`。详见 [目录协议](docs/CATALOG_PROTOCOL.md)。

## 新增与更新资源

投稿步骤、字段与例子见 [贡献说明](CONTRIBUTING.md)。源文件存储在普通 Git 中；需要 LFS 时再单独配置。工具遇到尚未展开的 LFS 指针会拒绝生成，正式索引必须描述真实文件。

资源作者和服务状态应填写真实来源信息。`license` 为可选信息；已知时可以保留，不知道时省略。原有上游授权文件不由索引工具删除。

## 发布与验收范围

本地测试覆盖目录、版本和 Git 发布行为，不代表实际 GitHub Actions、分支规则、访问凭据、网络分发或 NG 客户端已经验证。工作流推送后，还需要在真实 GitHub 仓库完成首次目录初始化、PR 检查和自动发布验证。

根目录的 `catalog.config.json` 用 `purposes` 声明四个一级用途，用每个分类的 `purpose` 关联用途；`categories` 继续描述 `resources/` 下真实可安装的资源类型。显示名称与用途不参与安装版本比较，分类 ID、资源 ID 和文件路径保持稳定。生成器只读取该目录中的资源说明；新增任意目录不会自动赋予 NG 一种新安装能力，NG 仍需要对应的类型适配器。

## 宠物插件

宠物插件以标准 ZIP 分发。阅读按 `pet` 分类下载，在用户启用后加载包中的代码，素材保留原始质量。生成器检查 DEX 和 `assets/plugin.json`，核对插件身份与修订号。具有 `pet.api.2` 能力的宿主可以安装咕嘎、蓝色大肥鱼及符合相同契约的新宠物。作者接入流程见[投稿说明](CONTRIBUTING.md#宠物插件)。
