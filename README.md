# Affinity CJK Regex Tracking

**Version:** 0.6.0
**Target:** Affinity by Canva desktop scripting API (SDK 3.3.x)
**Platform:** macOS / Windows desktop
**License:** MIT

此脚本在当前文档的页面和可访问母版页文本中，用正则查找中西文相邻字符，并将命中的字符 `CharacterSpacing` 设置为 `125‰`（`0.125 em`）。

## 匹配规则

中日韩字符后接 ASCII 字母或数字：

```regex
[ぁ-ゖァ-ー\x{32FF}㍻-㍾\x{3400}-\x{4DBF}\x{4E00}-\x{9FFF}\x{F900}-\x{FAFF}](?=[0-9A-Za-z])
```

ASCII 字母或数字后接中日韩字符：

```regex
[0-9A-Za-z](?=[ぁ-ゖァ-ー\x{3400}-\x{4DBF}\x{4E00}-\x{9FFF}\x{F900}-\x{FAFF}])
```

脚本使用 JavaScript 正则查找匹配字符，并通过 Affinity 格式命令将命中字符的 Tracking 设为 125‰。不会改写文本；已设为 125‰ 的匹配项会跳过。连续标点挤压和其他审校功能已移除。

调整会写入文档格式，可使用 Affinity 的撤销命令恢复。脚本扫描范围受 SDK 暴露的文本节点限制；无法读取或应用的项目会列入控制台报告。
