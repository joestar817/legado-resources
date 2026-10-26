# 预览工具的补字字体

`preview-fallback.ttf` 仅供自动字体样张生成器使用，不是资源库中的可下载字体，也不会写入被预览的源字体。固定 Windows 风格样例中，源字体缺少的字符使用这份字体补齐。

- 原始字体：Google Fonts 的 Noto Sans SC 可变字体，固定提交 `e7db6ca603fd4862010383ff17ffd6cc4ffac1c0`。
- [上游文件](https://github.com/google/fonts/blob/e7db6ca603fd4862010383ff17ffd6cc4ffac1c0/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf)，原始 SHA256：`a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da`。
- 生成方式：保留 ASCII 可打印字符和“中国智造，慧及全球”，固定字重 400，内部名称改为 `NG Preview Fallback`，保留版权及许可信息。
- 子集 SHA256：`16e044c9870f9e77dbff0aff69ba77e689c26902630822eaade8774d3bfb5c94`，19,892 bytes。
- 原始及派生字体采用 SIL Open Font License 1.1，完整上游声明保存在同目录 `OFL.txt`。

使用 `tools/font-preview-requirements.txt` 中固定的 fontTools 版本，在取得上述原始字体后重建到新的输出文件：

```text
python3 -B tools/build-preview-fallback.py --source /absolute/path/NotoSansSC-variable.ttf --out /absolute/path/new-preview-fallback.ttf
```

重建脚本不联网、拒绝错误来源摘要及覆盖已有输出。正常目录发布使用已随工具保存的子集文件，无需下载上游完整字体，也无需资源作者维护额外字段。
