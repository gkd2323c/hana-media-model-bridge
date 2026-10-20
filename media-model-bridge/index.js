import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { defineApp } from "./sdk/app-contract/server-client.js";

export const name = "media-model-bridge";

const PROVIDER_ID = "model-bridge";
const IMAGE_PROTOCOL = "model-bridge-openai-images";
const VIDEO_PROTOCOL = "model-bridge-openai-videos";
const CONFIG_FILE = "config.json";
const JOBS_DIR = "jobs";
const TMP_DIR = "tmp";
const JOB_TTL_MS = 2 * 60 * 60 * 1000;

function toSlash(value) {
  return String(value).replace(/\\/g, "/");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function emptyConfig() {
  return { providers: [] };
}

function normalizeExtra(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      return {};
    }
  }
  return {};
}

function guessSize(id, type) {
  if ((type || guessType(id)) === "video") return "720P";
  return /^agnes-image/i.test(id || "") ? "1K" : "1024x1024";
}

function guessType(id) {
  return /video/i.test(id || "") ? "video" : "image";
}

function normalizeModel(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) return null;
  const sizes = Array.isArray(raw.sizes)
    ? raw.sizes.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
    : [];
  const explicitSize =
    (typeof raw.size === "string" && raw.size.trim()) ||
    (typeof raw.defaultSize === "string" && raw.defaultSize.trim()) ||
    sizes[0] ||
    "";
  const type = raw.type === "video" || raw.type === "image" ? raw.type : guessType(id);
  const resolvedSize = explicitSize || guessSize(id, type);
  const entry = {
    id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id,
    type,
    size: resolvedSize,
    ratio:
      typeof raw.ratio === "string" && raw.ratio.trim()
        ? raw.ratio.trim()
        : type === "video"
          ? typeof raw.aspectRatio === "string" && raw.aspectRatio.trim()
            ? raw.aspectRatio.trim()
            : "16:9"
          : "",
    seconds:
      type === "video"
        ? String(raw.seconds || raw.duration || "5").trim() || "5"
        : "",
    sizes,
    defaultSize: resolvedSize,
    extra: normalizeExtra(raw.extra),
  };
  return entry;
}

function normalizeProvider(raw, index) {
  if (!raw || typeof raw !== "object") return null;
  const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : "";
  if (!baseUrl) return null;
  const rawId = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `p${index + 1}`;
  const id = rawId.replace(/[^A-Za-z0-9_-]/g, "") || `p${index + 1}`;
  const models = Array.isArray(raw.models)
    ? raw.models.map(normalizeModel).filter(Boolean)
    : [];
  return {
    id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id,
    baseUrl,
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey.trim() : "",
    models,
  };
}

function normalizeConfig(raw) {
  const providers = Array.isArray(raw?.providers)
    ? raw.providers.map(normalizeProvider).filter(Boolean)
    : [];
  const seen = new Set();
  for (const provider of providers) {
    let candidate = provider.id;
    let suffix = 2;
    while (seen.has(candidate)) candidate = `${provider.id}${suffix++}`;
    provider.id = candidate;
    seen.add(candidate);
  }
  return { providers };
}

function readConfig(dataDir) {
  const file = path.join(dataDir, CONFIG_FILE);
  try {
    const text = fs.readFileSync(file, "utf8");
    return normalizeConfig(JSON.parse(text));
  } catch {
    return emptyConfig();
  }
}

function writeConfig(dataDir, config) {
  ensureDir(dataDir);
  const file = path.join(dataDir, CONFIG_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf8");
  fs.renameSync(tmp, file);
  return config;
}

function parseModelKey(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text.startsWith("p:")) return null;
  const body = text.slice(2);
  const split = body.indexOf("::");
  if (split <= 0) return null;
  const providerId = body.slice(0, split);
  const modelId = body.slice(split + 2);
  if (!providerId || !modelId) return null;
  return { providerId, modelId };
}

function findTarget(config, modelId) {
  const text = typeof modelId === "string" ? modelId.trim() : "";
  if (!text) return null;
  const parsed = parseModelKey(text);
  if (parsed) {
    const provider = config.providers.find((item) => item.id === parsed.providerId);
    const model = provider?.models.find((item) => item.id === parsed.modelId);
    return provider && model ? { provider, model } : null;
  }
  for (const provider of config.providers) {
    const model = provider.models.find((item) => item.id === text);
    if (model) return { provider, model };
  }
  return null;
}

const SYNC_FILE = "synced-models.json";

function readSynced(dataDir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dataDir, SYNC_FILE), "utf8"));
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function writeSynced(dataDir, ids) {
  ensureDir(dataDir);
  fs.writeFileSync(path.join(dataDir, SYNC_FILE), JSON.stringify(ids), "utf8");
}

// 把配置里的模型写进宿主 catalog：provider 身份来自本地 provider 插件，
// 模型通过 ctx.media.addModel 落到宿主，这样多媒体设置页才能枚举到。
async function syncCatalogModels(sdk, config) {
  const dataDir = sdk.dataDir;
  const desired = new Map();
  for (const provider of config.providers) {
    for (const model of provider.models) {
      const capability = model.type === "video" ? "video_generation" : "image_generation";
      desired.set(`${capability}:${model.id}`, { capability, model });
    }
  }
  const errors = [];
  for (const key of readSynced(dataDir)) {
    if (desired.has(key)) continue;
    const split = key.indexOf(":");
    const capability = split > 0 ? key.slice(0, split) : "image_generation";
    const id = split > 0 ? key.slice(split + 1) : key;
    try {
      await sdk.media.removeModel(PROVIDER_ID, capability, id);
    } catch (error) {
      errors.push(`${id}: ${error?.message || error}`);
    }
  }
  for (const { capability, model } of desired.values()) {
    const definition = {
      id: model.id,
      displayName: model.id,
      protocolId: capability === "video_generation" ? VIDEO_PROTOCOL : IMAGE_PROTOCOL,
      inputs: ["text"],
      outputs: [capability === "video_generation" ? "video" : "image"],
      modes: [
        capability === "video_generation"
          ? { id: "text2video", label: "文生视频" }
          : { id: "text2image", label: "文生图" },
      ],
    };
    try {
      await sdk.media.addModel(PROVIDER_ID, capability, definition);
    } catch (error) {
      try {
        await sdk.media.updateModel(PROVIDER_ID, capability, model.id, {
          displayName: model.id,
          protocolId: definition.protocolId,
        });
      } catch (inner) {
        errors.push(`${model.id}: ${inner?.message || inner}`);
      }
    }
  }
  writeSynced(dataDir, [...desired.keys()]);
  return errors;
}

async function performCurl({ curlPath, method = "POST", url, headers = [], bodyPath = null, outPath, timeoutSec = 120 }) {
  const escape = (value) => String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const lines = [
    `url = "${escape(url)}"`,
    `request = "${method}"`,
    ...headers.map((header) => `header = "${escape(header)}"`),
    ...(bodyPath ? [`data = "@${escape(toSlash(bodyPath))}"`] : []),
    `output = "${escape(toSlash(outPath))}"`,
    `silent`,
    `show-error`,
    `max-time = ${timeoutSec}`,
    `write-out = "%{http_code}"`,
  ];
  const result = await runProcess(curlPath, ["-sS", "-K", "-"], `${lines.join("\n")}\n`, (timeoutSec + 30) * 1000);
  const status = Number(String(result.stdout || "").trim().slice(-3)) || 0;
  let payload = null;
  try {
    payload = JSON.parse(fs.readFileSync(outPath, "utf8"));
  } catch {
    payload = null;
  }
  return { code: result.code, status, payload, stderr: result.stderr };
}

async function submitVideo({ provider, model, params, dataDir, taskId, curlPath }) {
  if (!provider.apiKey) throw new Error(`供应商「${provider.name}」还没有填写 API Key`);
  const prompt = String(params.prompt || "").trim();
  if (!prompt) throw new Error("缺少 prompt");
  const seconds = String(params.duration || params.seconds || model.seconds || "5").trim();
  const ratio = String(params.ratio || params.options?.ratio || model.ratio || "16:9").trim();
  const size = String(params.resolution || params.size || model.size || "720P").trim();
  const requestedMode = String(params.mode || params.options?.mode || "").trim();
  const mode = /keyframe/i.test(requestedMode) ? "keyframe" : /reference/i.test(requestedMode) ? "reference" : "text";
  const endpoint = `${provider.baseUrl.replace(/\/+$/, "")}/videos`;
  const body = { ...model.extra, model: model.id, prompt, seconds, mode, size, aspect_ratio: ratio };
  const tmpDir = ensureDir(path.join(dataDir, TMP_DIR));
  const bodyPath = path.join(tmpDir, `${taskId}.vbody.json`);
  const respPath = path.join(tmpDir, `${taskId}.vresp.json`);
  fs.writeFileSync(bodyPath, JSON.stringify(body), "utf8");

  let result;
  try {
    result = await performCurl({
      curlPath,
      method: "POST",
      url: endpoint,
      headers: ["Content-Type: application/json", `Authorization: Bearer ${provider.apiKey}`],
      bodyPath,
      outPath: respPath,
      timeoutSec: 120,
    });
  } finally {
    try {
      fs.unlinkSync(bodyPath);
    } catch {}
  }
  const payload = result.payload;
  const cleanup = () => {
    try {
      fs.unlinkSync(respPath);
    } catch {}
  };
  if (result.status >= 400 || !payload) {
    cleanup();
    const message = payload?.detail || payload?.error?.message || payload?.message || result.stderr || `HTTP ${result.status || "未知"}`;
    throw new Error(String(message));
  }
  const videoId = payload.video_id || payload.id || payload.task_id;
  if (!videoId) {
    cleanup();
    throw new Error("服务端没有返回 video_id");
  }
  cleanup();
  return { videoId: String(videoId), mode, size, seconds, ratio };
}

async function queryVideo({ provider, model, videoId, dataDir, generatedDir, taskId, curlPath }) {
  const origin = new URL(provider.baseUrl).origin;
  const legacyAgnesPath = /^agnes-/i.test(model.id) ? "/agnesapi?video_id={id}&model_name={model}" : "";
  const template =
    (typeof model.extra?.queryPath === "string" && model.extra.queryPath.trim()) ||
    legacyAgnesPath ||
    "/videos/{id}";
  const pathAndQuery = template
    .replace("{id}", encodeURIComponent(videoId))
    .replace("{model}", encodeURIComponent(model.id));
  const url = `${origin}${pathAndQuery}`;
  const respPath = path.join(ensureDir(path.join(dataDir, TMP_DIR)), `${taskId}.vquery.json`);
  let result;
  try {
    result = await performCurl({
      curlPath,
      method: "GET",
      url,
      headers: [`Authorization: Bearer ${provider.apiKey}`],
      outPath: respPath,
      timeoutSec: 60,
    });
  } finally {
    try {
      fs.unlinkSync(respPath);
    } catch {}
  }
  const payload = result.payload;
  if (!payload) return { status: "pending" };
  const status = String(payload.status || "").toLowerCase();
  if (status === "failed") {
    return {
      status: "failed",
      failReason: payload.error?.message || payload.error || payload.detail || "视频生成失败",
      error: { code: "MODEL_BRIDGE_VIDEO_FAILED", message: String(payload.error?.message || payload.error || payload.detail || "视频生成失败") },
    };
  }
  if (status === "completed" && typeof payload.url === "string" && payload.url) {
    const ext = /\.[a-z0-9]{2,4}(\?|$)/i.exec(payload.url)?.[0]?.replace("?", "") || ".mp4";
    const target = path.join(generatedDir, `model-bridge-${taskId}-1${ext}`);
    const download = await runProcess(curlPath, ["-sS", "-L", "--max-time", "300", "-o", target, payload.url], null, 330000);
    if (download.code !== 0 || !fs.existsSync(target) || fs.statSync(target).size === 0) {
      return { status: "failed", failReason: `下载视频失败：${download.stderr || payload.url}`, error: { code: "MODEL_BRIDGE_VIDEO_DOWNLOAD_FAILED", message: download.stderr || "下载失败" } };
    }
    return { status: "success", files: [path.basename(target)] };
  }
  return { status: "pending" };
}

function runProcess(command, args, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      reject(new Error("请求超时，已终止 curl 进程"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

function curlConfigText({ url, headers, bodyPath, outPath, writeOut, timeoutSec }) {
  const escape = (value) => String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const keyword = (key) => {
    const match = String(key).match(/^[^:\s]+/);
    return match ? match[0] : "header";
  };
  const lines = [
    `url = "${escape(url)}"`,
    `request = "POST"`,
    ...headers.map((header) => `header = "${escape(`${keyword(header)}: ${header.slice(header.indexOf(":") + 1).trim()}`)}"`),
    `data = "@${escape(toSlash(bodyPath))}"`,
    `output = "${escape(toSlash(outPath))}"`,
    `silent`,
    `show-error`,
    `max-time = ${timeoutSec}`,
    `write-out = "${writeOut}"`,
  ];
  return `${lines.join("\n")}\n`;
}

function extractImages(json) {
  const found = [];
  const push = (value) => {
    if (typeof value === "string" && value.trim()) found.push(value.trim());
  };
  if (Array.isArray(json?.data)) {
    for (const item of json.data) {
      push(item?.b64_json);
      push(item?.b64);
      push(item?.base64);
      push(item?.url);
    }
  }
  if (Array.isArray(json?.images)) {
    for (const item of json.images) {
      if (typeof item === "string") push(item);
      else {
        push(item?.b64_json);
        push(item?.url);
      }
    }
  }
  if (Array.isArray(json?.output)) {
    for (const item of json.output) {
      push(typeof item === "string" ? item : item?.url || item?.b64_json);
    }
  }
  push(json?.image);
  push(json?.url);
  return found;
}

function extensionFor(value, fallback) {
  const match = String(value).match(/\.(png|jpe?g|webp|gif)\b/i);
  return match ? match[1].toLowerCase().replace("jpeg", "jpg") : fallback;
}

async function materializeImages(values, { curlPath, generatedDir, taskId, timeoutSec }) {
  ensureDir(generatedDir);
  const files = [];
  let index = 0;
  for (const value of values) {
    index += 1;
    const base = `model-bridge-${taskId}-${index}`;
    if (value.startsWith("http://") || value.startsWith("https://")) {
      const target = path.join(generatedDir, `${base}.${extensionFor(value, "png")}`);
      const result = await runProcess(
        curlPath,
        ["-sS", "-L", "--max-time", String(timeoutSec), "-o", target, value],
        null,
        (timeoutSec + 20) * 1000,
      );
      if (result.code !== 0 || !fs.existsSync(target) || fs.statSync(target).size === 0) {
        throw new Error(`下载生成结果失败：${result.stderr || value}`);
      }
      files.push(path.basename(target));
      continue;
    }
    const comma = value.indexOf(",");
    const base64 = value.startsWith("data:") && comma >= 0 ? value.slice(comma + 1) : value;
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length === 0) throw new Error("服务返回了无法解码的图片数据");
    const target = path.join(generatedDir, `${base}.${extensionFor(value, "png")}`);
    fs.writeFileSync(target, bytes);
    files.push(path.basename(target));
  }
  return files;
}

function jobPath(dataDir, taskId) {
  return path.join(dataDir, JOBS_DIR, `${taskId}.json`);
}

function writeJob(dataDir, taskId, payload) {
  const dir = ensureDir(path.join(dataDir, JOBS_DIR));
  const file = path.join(dir, `${taskId}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...payload, updatedAt: Date.now() }), "utf8");
}

function readJob(dataDir, taskId) {
  const file = jobPath(dataDir, String(taskId).replace(/[^A-Za-z0-9_-]/g, ""));
  try {
    const job = JSON.parse(fs.readFileSync(file, "utf8"));
    if (job?.updatedAt && Date.now() - job.updatedAt > JOB_TTL_MS) return null;
    return job;
  } catch {
    return null;
  }
}

async function generateImage({ provider, model, params, dataDir, generatedDir, taskId, curlPath }) {
  if (!curlPath) throw new Error("未找到 curl 可执行文件，无法发送生成请求");
  if (!provider.apiKey) throw new Error(`供应商「${provider.name}」还没有填写 API Key`);

  const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
  if (!prompt) throw new Error("缺少 prompt");

  const extra = model.extra && typeof model.extra === "object" && !Array.isArray(model.extra) ? model.extra : {};
  const size = String(
    params.size || params.options?.size || extra.size || model.size || model.defaultSize || "",
  ).trim();
  const ratio = String(params.ratio || params.options?.ratio || extra.ratio || model.ratio || "").trim();
  const count = Number(params.n || params.options?.n || 1);
  const endpoint = /\/images\/generations$/i.test(provider.baseUrl)
    ? provider.baseUrl
    : `${provider.baseUrl.replace(/\/+$/, "")}/images/generations`;

  const body = { ...extra, model: model.id, prompt };
  if (size) body.size = size;
  else delete body.size;
  if (ratio) body.ratio = ratio;
  if (Number.isFinite(count) && count > 1) body.n = Math.min(Math.floor(count), 4);
  if (typeof params.quality === "string" && params.quality.trim()) body.quality = params.quality.trim();
  if (typeof params.background === "string" && params.background.trim()) body.background = params.background.trim();

  const tmpDir = ensureDir(path.join(dataDir, TMP_DIR));
  const bodyPath = path.join(tmpDir, `${taskId}.body.json`);
  const respPath = path.join(tmpDir, `${taskId}.resp.json`);
  fs.writeFileSync(bodyPath, JSON.stringify(body), "utf8");

  const timeoutSec = 180;
  const configText = curlConfigText({
    url: endpoint,
    headers: ["Content-Type: application/json", `Authorization: Bearer ${provider.apiKey}`],
    bodyPath,
    outPath: respPath,
    writeOut: "%{http_code}",
    timeoutSec,
  });

  const result = await runProcess(curlPath, ["-sS", "-K", "-"], configText, (timeoutSec + 30) * 1000);
  const statusText = String(result.stdout || "").trim();
  const status = Number(statusText.slice(-3)) || 0;

  let payload = null;
  try {
    payload = JSON.parse(fs.readFileSync(respPath, "utf8"));
  } catch {
    payload = null;
  }

  const cleanup = () => {
    for (const file of [bodyPath, respPath]) {
      try {
        fs.unlinkSync(file);
      } catch {}
    }
  };

  if (result.code !== 0 && !payload) {
    cleanup();
    throw new Error(`请求失败：${result.stderr || `curl 退出码 ${result.code}`}`);
  }
  if (status >= 400) {
    const message =
      payload?.error?.message ||
      payload?.message ||
      payload?.error ||
      result.stderr ||
      `HTTP ${status || "未知"}`;
    cleanup();
    throw new Error(String(message));
  }

  const values = payload ? extractImages(payload) : [];
  if (values.length === 0) {
    cleanup();
    const hint = status ? `HTTP ${status}` : "响应中没有图片字段";
    throw new Error(`生成结果为空（${hint}）`);
  }

  const files = await materializeImages(values, {
    curlPath,
    generatedDir,
    taskId,
    timeoutSec,
  });
  cleanup();
  return files;
}

export default defineApp(async (sdk) => {
  const dataDir = sdk.dataDir;
  let curlPath = null;
  try {
    const resolved = await sdk.process.resolveExecutable({ candidates: ["curl", "curl.exe"] });
    curlPath = resolved?.path || null;
  } catch (error) {
    await sdk.logger.warn(`model-bridge: curl 不可用：${error?.message || error}`);
  }

  const checkAuth = async () => {
    const config = readConfig(dataDir);
    if (!curlPath) return { ok: false, message: "未找到 curl，无法发送请求" };
    if (!config.providers.some((provider) => provider.models.length > 0)) {
      return { ok: false, message: "还没有配置任何模型，请到「多媒体模型桥」设置里添加" };
    }
    return { ok: true };
  };

  const submitMedia = async (params = {}, ctx = {}) => {
    const root = dataDir || ctx.dataDir;
    const config = readConfig(root);
    const target = findTarget(config, params.modelId || params.model);
    const taskId = `mb_${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
    const generatedDir = ctx.generatedDir || path.join(root, "generated");
    if (!target) {
      writeJob(root, taskId, { status: "failed", error: `未找到模型：${params.modelId || params.model || "(未指定)"}` });
      return { taskId };
    }
    try {
      if (target.model.type === "video") {
        const submitted = await submitVideo({
          provider: target.provider,
          model: target.model,
          params,
          dataDir: root,
          taskId,
          curlPath,
        });
        writeJob(root, taskId, {
          status: "pending",
          type: "video",
          modelId: target.model.id,
          videoId: submitted.videoId,
        });
      } else {
        const files = await generateImage({
          provider: target.provider,
          model: target.model,
          params,
          dataDir: root,
          generatedDir,
          taskId,
          curlPath,
        });
        writeJob(root, taskId, { status: "success", files });
      }
    } catch (error) {
      writeJob(root, taskId, {
        status: "failed",
        type: target.model.type,
        modelId: target.model.id,
        error: String(error?.message || error),
      });
    }
    return { taskId };
  };

  const queryMedia = async (taskId, ctx = {}) => {
    const root = dataDir || ctx?.dataDir;
    const job = readJob(root, taskId);
    if (!job) return { status: "pending" };
    if (job.status === "success") return { status: "success", files: job.files || [] };
    if (job.status === "failed") {
      return {
        status: "failed",
        failReason: job.error || "生成失败",
        error: { code: "MODEL_BRIDGE_FAILED", message: job.error || "生成失败" },
      };
    }
    if (job.type === "video" && job.videoId) {
      const config = readConfig(root);
      const target = findTarget(config, job.modelId);
      if (!target) {
        return {
          status: "failed",
          failReason: "供应商配置已不存在",
          error: { code: "MODEL_BRIDGE_NO_PROVIDER", message: "供应商配置已不存在" },
        };
      }
      const generatedDir = ctx.generatedDir || path.join(root, "generated");
      const result = await queryVideo({
        provider: target.provider,
        model: target.model,
        videoId: job.videoId,
        dataDir: root,
        generatedDir,
        taskId,
        curlPath,
      });
      if (result.status === "success") {
        writeJob(root, taskId, { status: "success", type: "video", modelId: job.modelId, files: result.files });
      } else if (result.status === "failed") {
        writeJob(root, taskId, { status: "failed", type: "video", modelId: job.modelId, error: result.failReason });
      }
      return result;
    }
    return { status: "pending" };
  };

  let mediaReady = false;
  let mediaError = "";

  try {
    await sdk.logger.info(`model-bridge: registering adapter for provider "${PROVIDER_ID}"`);
    await sdk.media.registerAdapter({
    id: "model-bridge-images",
    protocolId: IMAGE_PROTOCOL,
    name: "模型桥图片生成",
    types: ["image"],
    capabilities: {},
    checkAuth,
    submit: submitMedia,
    query: queryMedia,
    });

    await sdk.media.registerAdapter({
      id: "model-bridge-videos",
      protocolId: VIDEO_PROTOCOL,
      name: "模型桥视频生成",
      types: ["video"],
      capabilities: {},
      checkAuth,
      submit: submitMedia,
      query: queryMedia,
    });
    mediaReady = true;
    await sdk.logger.info("model-bridge: adapter registered");
  } catch (error) {
    mediaError = String(error?.message || error);
    await sdk.logger.warn(`model-bridge: 媒体提供方注册失败：${mediaError}`);
  }

  try {
    const startupErrors = await syncCatalogModels(sdk, readConfig(dataDir));
    if (startupErrors.length) {
      await sdk.logger.warn(`model-bridge: 模型同步有 ${startupErrors.length} 项失败：${startupErrors.join("; ")}`);
    }
  } catch (error) {
    await sdk.logger.warn(`model-bridge: 模型同步失败：${error?.message || error}`);
  }

  sdk.routes.register((app) => {
    app.get("/config", (c) =>
      c.json({
        ...readConfig(dataDir),
        providerId: PROVIDER_ID,
        curlAvailable: Boolean(curlPath),
        mediaReady,
        mediaError,
      }),
    );
    app.put("/config", async (c) => {
      const body = await c.req.json();
      const config = writeConfig(dataDir, normalizeConfig(body));
      let syncErrors = [];
      try {
        syncErrors = await syncCatalogModels(sdk, config);
      } catch (error) {
        syncErrors = [String(error?.message || error)];
      }
      return c.json({
        ...config,
        providerId: PROVIDER_ID,
        curlAvailable: Boolean(curlPath),
        mediaReady,
        mediaError,
        syncErrors,
      });
    });
    app.get("/status", (c) => {
      const config = readConfig(dataDir);
      return c.json({
        providerId: PROVIDER_ID,
        curlAvailable: Boolean(curlPath),
        mediaReady,
        mediaError,
        providers: config.providers.map((provider) => ({
          id: provider.id,
          name: provider.name,
          models: provider.models.length,
          hasKey: Boolean(provider.apiKey),
        })),
      });
    });
  });

  await sdk.tools.register({
    name: "media_model_bridge_status",
    description: "列出多媒体模型桥当前的供应商与模型数量（含图片与视频），用于确认自定义模型是否已经接入。",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const config = readConfig(dataDir);
      const lines = config.providers.length
        ? config.providers.map(
            (provider) =>
              `${provider.name}: ${provider.models.length} 个模型${provider.models.length ? `（${provider.models.map((m) => m.name).join("、")}）` : ""}${provider.apiKey ? "" : "，缺少 API Key"}`,
          )
        : ["还没有配置任何供应商"];
      return {
        content: [
          {
            type: "text",
            text: [`模型桥提供方：${PROVIDER_ID}`, `curl：${curlPath ? "可用" : "不可用"}`, ...lines].join("\n"),
          },
        ],
      };
    },
  });
});
