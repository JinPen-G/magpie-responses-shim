# 第三方代码声明

`lib/sanitize.mjs` 来自 `agentrouter-responses-shim` 2.0.1 的 MIT 清理器，并包含本地修复包 `2.0.1+codex-idfix.1` 对完整 `additional_tools` 顶层 ID 的清理补丁。

本仓库初始版本逐字节保留了该补丁清理器，SHA-256 为 `f2a2bca2d461cb74428df5a216762cb95e2c16219dfe3892cb7eec0f72d2d356`。Magpie 适配入口由本项目提供。[上游 npm 项目](https://www.npmjs.com/package/agentrouter-responses-shim)

上游许可证原文如下。

```text
MIT License

Copyright (c) 2026 stevenarai

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
