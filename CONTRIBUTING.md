# 贡献资源

将资源放入 `resources/` 下的对应分类，并在旁边添加以 `.resource.json` 结尾的 UTF-8 JSON 说明。一个说明对应一个载荷文件；资源可放分类子目录，不需要修改总索引。`payload.path` 从仓库根目录计算，必须带 `resources/<分类>/` 前缀。

资源中心按用途浏览：阅读预设包放 `read-presets`，外观主题包放 `themes`，听书 TTS 脚本放 `tts`。字体和背景请打包进阅读预设，不再单独上架。用途由受信 `catalog.config.json` 统一维护，投稿元数据不重复填写 `purpose`。宠物代码插件放在 `resources/pets/`。

## 阅读预设例子

从阅读设置导出 ZIP，包含配置、所用图片和字体后，与说明文件放在同一目录：

```json
{
  "schemaVersion": 1,
  "id": "read.preset.example",
  "name": "示例预设",
  "author": "实际作者",
  "description": "简短说明适合的阅读场景。",
  "payload": {
    "path": "resources/read-presets/example/preset.zip",
    "format": "zip"
  }
}
```

请确认包内素材的发布授权，附带字体等素材要求的许可证，并填写真实署名。`license` 为可选；没有许可信息时不要猜测。

## TTS 例子

```json
{
  "schemaVersion": 1,
  "id": "tts.example.reader",
  "payload": {
    "path": "resources/tts/example.js",
    "format": "js"
  }
}
```

脚本头部应有 `// @uuid`、`// @name`、`// @author`；可附 `// @version` 和 `// @description`。工具静态读取这些注释，不执行 JS。说明中显式填写的 `name`、`author`、`versionName` 可覆盖相应展示值；避免重复维护没有必要的字段。

## 离线语音整合包

微软离线语音使用标准 ZIP，归入 `tts`，`payload.format` 为 `zip`，并声明 `requirements.capabilities: ["tts.offline.microsoft.1"]`。参考 [云希、晓晓整合包说明](resources/tts/microsoft-offline/bundle.resource.json)。包内必须是完整的 `ng-tts-package` bundle，含引擎、模型、中文发音人和运行所需文件；不发布个人账号配置或签名私钥。

大包上传到本仓库固定版本的 Release，资源说明中填写 `payload.release` 的 `tag`、`asset`、实际 `size` 和 `sha256`。`payload.path` 仍保留分类内稳定路径作为资源逻辑标识，此时无需将 ZIP 提交到 Git。生成器只从 `joestar817/legado-resources` 的指定 Release 下载，校验字节数、SHA-256 与包清单后生成索引；不接受任意 URL。可将完整 ZIP 放在 `.local/release-assets/<sha256>.zip` 供本地校验，缓存同样必须通过摘要校验。

更新时新建版本标签和附件，不覆盖原附件；再修改资源说明。目录修订号按 ZIP 内容自动增长，与包内修订号分开维护。先上传附件、再提交说明，附件不可用或摘要不符时目录发布会失败，已发布目录不变。

## 宠物插件

作者可下载[宠物开发 SDK 2.0.0](sdk/pet/2.0.0/pet-sdk-2.0.0.zip)，解压后按包内说明从独立工程构建自己的宠物。SDK 归档与用户安装的角色包分别发布，资源中心“宠物”列表只收录角色包。

提交独立 SDK 生成的标准 ZIP 和同目录的资源说明。ZIP 根含 `classes.dex`，`assets/plugin.json` 声明 `schemaVersion: 2`、`apiVersion: 2`、`kind: "pet"`、稳定的 `id`、`name`、`entryClass` 和 `versionCode`。素材由作者按需放入包内。`none` 和 `button` 是宿主保留 ID。

资源说明沿用目录协议 v1。填写 `payload.format: "zip"`、`payload.pluginId` 和 `requirements.capabilities: ["pet.api.2"]`。例如可参考[大肥鱼资源说明](resources/pets/blue_fish.resource.json)。首次上架时插件修订号取 1，更新内容时加 1。目录已有下载指纹时，同一资源的插件 ID 与首次发布时间应保持一致。正式发布和 PR 检查会用历史台账核对升级版本。

## 更新规则

- `id` 一经收录保持稳定；修改显示名称或移动文件都不改 ID。
- 直接修改资源文件，机器会计算摘要并增加 `versionCode`，不手填机器版本。
- TTS 的 `@uuid` 是实际引擎身份，同一资源应保持不变；另一个引擎应作为新资源提交。
- 更正介绍、署名或标签不会单独增加安装版本或改变更新时间。
- `publishedAt`、`updatedAt` 由发布器按受信源提交时间生成，分别表示首次收录和最近一次内容升版；不要手填。
- 删除资源时删除对应说明和不再使用的载荷；内部历史由发布器保留，作者不编辑台账。
- 不提交 `catalog.json`、分类 `index.json`、`state.json`、密钥、Cookie、账号配置或测试音频。

投稿可填写的可选说明字段为 `license`、`description`、`versionName`、`changelog`、`tags`、`requirements`。`requirements` 可填写 `minAppVersionCode` 与 `capabilities`。宠物和阅读预设还可填写 `previewSource`，提供 256×256 缩略图与 768×768 详情图，格式为 RGBA PNG，详见[预览规范](docs/CATALOG_PROTOCOL.md#宠物与阅读预设的预览)。

元数据只保留资源展示、识别、版本和安装所需的信息。校验日期、测试状态与验证过程放在投稿说明或本地记录中，不填写 `verification`，避免增加后续手动维护负担。

## 提交前

在仓库根目录执行：

```text
node tools/catalog.mjs validate --root .
```

提交 PR 后会再次自动检查。生成器或工作流的变更需要按代码变更审查；资源投稿的检查不会用具有发布凭据的任务执行 PR 中的代码。
