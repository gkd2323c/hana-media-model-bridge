# Hana 多媒体模型桥

把任意 OpenAI 兼容的图片与视频生成服务接进 [HanaAgent](https://openhanako.com)，模型清单由你自己维护。

Hana 的多媒体供应商是一组编译进宿主的定义，模型列表固定，无法在设置页新增供应商或给它加模型。这个项目补上那一环：用一个本地 provider 插件声明供应商身份，用一个 App 提供适配器和配置页，并把模型写进宿主的 provider catalog。

## 工作原理

三个部件，缺一不可：

| 部件 | 位置 | 作用 |
| --- | --- | --- |
| provider 插件 | `~/.hanako/provider-plugins/model-bridge/` | 让宿主把「模型桥（自定义）」当成正常供应商 |
| App 适配器 | `~/.hanako/apps/media-model-bridge/` | 发请求、解析结果、轮询视频任务 |
| 模型清单 | 运行时写入 `~/.hanako/provider-catalog.json` | 保存配置时经 `ctx.media.addModel` 落库，多媒体页立即可见 |

App 清单里的 `contributes.providers` 也被试过：宿主接受注册，但不会把它纳入媒体供应商枚举，所以这里没有使用。

## 安装

需要 HanaAgent 1.1.x 或更高版本，系统上有 `curl`。仓库里已经有打好包的安装件，不需要自己构建。

1. 从 [Releases](https://github.com/gkd2323c/hana-media-model-bridge/releases) 下载 `app-media-model-bridge-0.3.1.zip`。
2. 在 Hana 的「设置 → 已安装」里安装这个 zip，按提示批准。
3. 供应商身份是一个 provider 插件。Hana 没有为 provider 插件提供安装入口，只能手工放到 `~/.hanako/provider-plugins/model-bridge/`。在仓库根目录执行：

    PowerShell（Windows）：

    ```powershell
    $dest = "$env:USERPROFILE\.hanako\provider-plugins"
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Copy-Item -Recurse -Force .\provider-plugins\model-bridge $dest
    ```

    两行不能省成一句 `Copy-Item ... "$env:USERPROFILE\.hanako\provider-plugins\"`：目标目录不存在时，PowerShell 会把 `model-bridge/` 里的内容直接摊到 `provider-plugins/` 根下，宿主就不认这个插件了。

    bash（macOS / Linux）：

    ```bash
    mkdir -p ~/.hanako/provider-plugins
    cp -R provider-plugins/model-bridge ~/.hanako/provider-plugins/
    ```

    只从 Releases 拿了 zip、没有克隆仓库的话，下载同一个 Release 里的 `provider-plugins-0.3.1.zip`，解压后按同样层级放进 `~/.hanako/provider-plugins/`：

    PowerShell（Windows）：

    ```powershell
    $zip   = "$env:USERPROFILE\Downloads\provider-plugins-0.3.1.zip"
    $stage = Join-Path $env:TEMP "pp-unzip"
    $dest  = "$env:USERPROFILE\.hanako\provider-plugins"
    Expand-Archive -Force $zip $stage
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Copy-Item -Recurse -Force (Join-Path $stage "model-bridge") $dest
    ```

    bash（macOS / Linux）：

    ```bash
    unzip -o ~/Downloads/provider-plugins-0.3.1.zip -d /tmp/pp-unzip
    mkdir -p ~/.hanako/provider-plugins
    cp -R /tmp/pp-unzip/model-bridge ~/.hanako/provider-plugins/
    ```

    落地后应当正好是 `manifest.json`（108 字节）与 `providers/model-bridge.json`（357 字节）；把目录里的内容摊到 `provider-plugins/` 根下，宿主不认这个插件。
4. 在「设置 → 应用 → 应用能力」打开三项能力：`app/media.provide`、`app/process.spawn`、`app/provider.models.manage`。
5. 重新加载 App（`app/process.spawn` 在下次启动时生效）。

## 使用

打开设置里的「多媒体模型桥」：

1. 添加供应商：名称、Base URL（例如 `https://api.example.com/v1`）、API Key。
2. 添加模型，只填模型 ID。类型按名字自动判断：带 `video` 的是视频，其余是图片，也可以手动切换。
3. 保存。图片模型出现在「多媒体 → 图片生成」，视频模型出现在「多媒体 → 视频生成」，供应商都叫「模型桥（自定义）」。

默认值按模型名给，不需要读服务商文档：

| 类型 | 默认尺寸 | 默认画幅 | 默认时长 |
| --- | --- | --- | --- |
| 图片 | 按模型名推断，档位式服务给 `1K`，像素式给 `1024x1024` | 不指定 | — |
| 视频 | `720P` | `16:9` | `5` 秒 |

这些只是默认值：生成时传 `ratio`、`duration` 等参数会覆盖它们，所以同一个模型可以按次决定。服务要求额外字段时，展开「高级：额外参数」，那段 JSON 会原样合并进请求体。

## 支持范围

- 图片：`POST {BaseURL}/images/generations`，按 `data[].b64_json` 或 `data[].url` 解析。
- 视频：`POST {BaseURL}/videos` 提交，再按服务商的查询接口轮询（默认 OpenAI 风格的 `/videos/{id}`，`agnes-` 开头的模型沿用 `/agnesapi?video_id={id}&model_name={model}`），`status=completed` 后从 `url` 下载。查询路径可在高级参数里用 `queryPath` 覆盖，模板支持 `{id}` 与 `{model}`。
- 目前视频只做文生视频（`mode: "text"`），首尾帧与图片参考尚未实现。

实测覆盖图片三种尺寸档与 720P 视频，均能正常出图与出片。

## 目录结构

```
media-model-bridge/
├─ media-model-bridge/               # App 源码（目录名必须等于 App id）
│  ├─ manifest.json
│  ├─ index.js                       # 适配器、catalog 同步、配置路由
│  ├─ ui/                            # 设置页（设置 Tab 与卡片共用同一份）
│  ├─ assets/
│  └─ sdk/                           # 脚手架提供的宿主 SDK 契约，随包分发
├─ provider-plugins/model-bridge/    # 供应商身份，放到 <HANA_HOME>/provider-plugins/
└─ dist/                             # 本地打包产物（不入库，发布时传到 Releases）
```

## 开发

源码在 `media-model-bridge/`（目录名必须与 App id 一致，打包器会校验）。改完代码重新打包：

```
node <hana-app-creator>/scripts/pack_app.mjs --dir ./media-model-bridge --publisher <你的名字> --out ./dist
```

`hana-app-creator` 是 Hana 自带的 App 开发 skill，位于 `~/.hanako/skills/hana-app-creator`。在已安装的 App 上改代码时，也可以在 App 详情页点「重新加载」，不需要重装；改了 `manifest.json` 的 `capabilities` 会要求重新确认一次。

App 的配置（含 API Key）保存在 `<HANA_HOME>/app-data/media-model-bridge/config.json`，不随仓库分发。

## 许可

MIT，见 [LICENSE](LICENSE)。
