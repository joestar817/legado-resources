# 贡献资源

将资源放入 `resources/` 下的对应分类，并在旁边添加以 `.resource.json` 结尾的 UTF-8 JSON 说明。一个说明对应一个载荷文件；资源可放分类子目录，不需要修改总索引。`payload.path` 从仓库根目录计算，必须带 `resources/<分类>/` 前缀。

## 字体例子

假设文件位于 `resources/fonts/example/font.ttf`，说明文件可以是 `resources/fonts/example/font.resource.json`：

```json
{
  "schemaVersion": 1,
  "id": "font.example.serif",
  "name": "示例宋体",
  "author": "实际作者",
  "description": "简短说明适合的阅读场景。",
  "license": "填写该字体真实的许可名称或标识",
  "payload": {
    "path": "resources/fonts/example/font.ttf",
    "format": "ttf"
  }
}
```

这只是说明格式，不是可以直接发布的真实字体。请填写真实署名与授权信息，不要把贡献者自动写成原作者。

## TTS 例子

```json
{
  "schemaVersion": 1,
  "id": "tts.example.reader",
  "license": "填写脚本真实的许可名称或标识",
  "payload": {
    "path": "resources/tts/example.js",
    "format": "js"
  }
}
```

脚本头部应有 `// @uuid`、`// @name`、`// @author`；可附 `// @version` 和 `// @description`。工具静态读取这些注释，不执行 JS。说明中显式填写的 `name`、`author`、`versionName` 可覆盖相应展示值；避免重复维护没有必要的字段。

## 更新规则

- `id` 一经收录保持稳定；修改显示名称或移动文件都不改 ID。
- 直接修改资源文件，机器会计算摘要并增加 `versionCode`，不手填机器版本。
- TTS 的 `@uuid` 是实际引擎身份，同一资源应保持不变；另一个引擎应作为新资源提交。
- 更正介绍、署名或标签不会单独增加安装版本。
- 删除资源时删除对应说明和不再使用的载荷；内部历史由发布器保留，作者不编辑台账。
- 不提交 `catalog.json`、分类 `index.json`、`state.json`、密钥、Cookie、账号配置或测试音频。

支持的可选说明字段为 `description`、`versionName`、`changelog`、`tags`、`requirements`、`verification`。`requirements` 可填写 `minAppVersionCode` 与 `capabilities`；`verification` 可填写 `checkedOn`（YYYY-MM-DD）、`status`、`note`，说明实际证据及未覆盖范围。

例如服务只通过本机短句测试时，应明确 Android 和长时间使用是否验证；不要把文件格式检查当作服务可用性验证。

## 提交前

在仓库根目录执行：

```text
node tools/catalog.mjs validate --root .
```

提交 PR 后会再次自动检查。生成器或工作流的变更需要按代码变更审查；资源投稿的检查不会用具有发布凭据的任务执行 PR 中的代码。
