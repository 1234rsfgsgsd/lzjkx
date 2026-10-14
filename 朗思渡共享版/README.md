# 朗思渡共享版

这是从原 HTML 复制出来的共享版。每位使用者的昵称、偏好和 PAST 记录仍保存在自己浏览器的 localStorage 中；服务器不保存这些练习记录。

## 本地运行

需要安装 Node.js 20 或更高版本。配置一个兼容 OpenAI Chat Completions、并且明确支持图片输入的视觉模型服务：

```powershell
$env:VISION_API_URL = '服务商提供的 chat/completions 地址'
$env:VISION_API_KEY = '你的服务密钥'
$env:VISION_MODEL = '支持图片输入的模型名称'
node server.js
```

然后打开 `http://localhost:3000`。API 密钥只在服务器环境变量中设置，不要放到 `index.html`。

## 部署到 Render 给同学和老师

1. 把 `朗思渡共享版` 目录上传到你自己的 GitHub 仓库。不要提交真实 `.env` 文件或 API 密钥。
2. 在 Render 选择 **New + → Blueprint**，连接该 GitHub 仓库，并选择其中的 `render.yaml`。
3. Render 要求填写 `VISION_API_URL`、`VISION_API_KEY`、`VISION_MODEL`。在 Render 控制台的环境变量中填入所选视觉模型服务给出的值。
4. 等待部署完成，打开 Render 提供的 `https://...onrender.com` 网址测试，再把网址发给同学和老师。

免费实例可能在一段时间无访问后休眠，首次打开会稍慢。公开网址意味着任何访问者都能调用照片识别；接口当前按 IP 每分钟限制 12 次、单图限制 10 MB。上线前请在托管平台设置使用量提醒，并按服务商规则选择可承受的用量/计费方案。

如果暂时不想用 GitHub，也可以先在本机测试：安装 Node.js 20+，在 PowerShell 中设置模型环境变量后运行 `node server.js`。本地地址只供本机使用，不是同学可访问的公网网址。

当前接入层要求视觉服务兼容 OpenAI Chat Completions 的图片输入与 JSON 输出格式。DeepSeek 可用于文本生成，但若所选 DeepSeek 模型/API 不接受图片，就不能单独识图；需配置支持图片输入的视觉模型服务。网页识图后返回场景和物体，之后仍可使用本地练习历史。

如果网站面向中国大陆公众提供服务，部署前需核实托管平台和网站备案要求。
