# 多媒体模型桥

把任意 OpenAI 兼容的图片与视频生成服务接进 Hana 的「多媒体 → 图片生成 / 视频生成」，模型清单由你自己维护，不受宿主内置供应商与协议前缀推断表限制。

## 结构

这套能力由三个部件组成，缺一不可：

1. **供应商身份** 来自本地 provider 插件 `~/.hanako/provider-plugins/model-bridge/`，它让宿主把「模型桥（自定义）」当作一个正常供应商列出来。
2. **适配器** 由本 App 通过 `ctx.media.registerAdapter` 注册两个：`model-bridge-openai-images` 打 `${BaseURL}/images/generations`；`model-bridge-openai-videos` 打 `${BaseURL}/videos`，再按服务商的查询接口轮询。
3. **模型清单** 由本 App 在保存配置时通过 `ctx.media.addModel` 按能力（`image_generation` / `video_generation`）写进宿主 provider catalog，因此会即时出现在多媒体设置页。

App 清单里的 `contributes.providers` 不再使用：宿主会接受这种声明，但不会把它纳入媒体供应商枚举。

## 需要授予的能力

安装后在「设置 → 应用 → 应用能力」打开，然后重新加载 App：

- `app/media.provide`：注册媒体适配器。
- `app/process.spawn`：通过 `curl` 发送 HTTP 请求。宿主给 App 的网络通道要求预先声明主机白名单，覆盖不了任意第三方服务，所以这里走外部命令。这一项在 App 进程下次启动时生效。
- `app/provider.models.manage`：把模型写进宿主 catalog。

## 使用

1. 打开设置页的「多媒体模型桥」，添加供应商（名称、Base URL、API Key）。
2. 添加模型，只填模型 ID 即可。类型按名字自动判断：带 `video` 视为视频，其余视为图片，也可手动切换。
3. 保存。图片模型出现在「多媒体 → 图片生成」，视频模型出现在「多媒体 → 视频生成」，供应商都叫「模型桥（自定义）」。
4. 想作为默认模型，在对应多媒体页底部把默认项改成这条。

默认值按模型名给：

| 类型 | 默认尺寸 | 默认画幅 | 默认时长 |
| --- | --- | --- | --- |
| 图片 | 按模型名推断，档位式服务给 `1K`，像素式给 `1024x1024` | 不指定 | — |
| 视频 | `720P` | `16:9` | `5` 秒 |

这份配置只是默认值：生成时传 `ratio`、`duration` 等参数会覆盖它，所以同一模型可以按次决定。只有服务要求额外字段时才展开「高级：额外参数」，那段 JSON 会原样合并进请求体，例如 `{"extra_body":{"response_format":"url"}}`。

## 边界

- 图片：服务端需实现 `POST /images/generations`，响应按 `data[].b64_json` 与 `data[].url` 两种形状解析。
- 视频：目前只走文生视频（`mode: "text"`），服务端需实现 `POST /videos` 与一个可查询任务状态的接口；默认按 OpenAI 风格的 `/videos/{id}` 轮询，`agnes-` 开头的模型沿用 `/agnesapi?video_id={id}&model_name={model}`，其它形式可在高级参数里用 `queryPath` 覆盖。
- 视频的 `size` 在部分服务上固定为 `720P`，`seconds` 取 `4`–`12`；超出范围的请求会被服务端拒绝。
- 产出写到 App 自己的 `generated` 目录，由宿主登记进会话。
- 配置保存在 App 数据目录的 `config.json`，API Key 明文存放，仅本机 App 与宿主可读。
- 卸载本 App 不会移除 `provider-plugins/model-bridge/`，换机器时这个目录需要一并带走。
