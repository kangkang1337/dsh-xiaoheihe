/**
 * heybox — host half(小黑盒论坛数据层).
 *
 * 移植自 WenfuRainbow/heybox(VSCode 小黑盒论坛插件)的数据层思路,签名与账号态
 * 都放在 dsh web 进程内,浏览器只通过语义 RPC 取数:
 *
 *   - GET/POST /heybox/health      → { ok: true } 安装检查
 *   - GET  /heybox/state           → { loggedIn, deviceId, heyboxId? }
 *   - POST /heybox/state           → { action: "login", cookie } | { action: "logout" }
 *   - POST /heybox/rpc             → { path, params?, method?, form? } 语义接口;
 *                                   主机侧完成 hkey/_time/nonce 签名 + 公共参数 +
 *                                   Cookie,返回 { ok, result } 或 { ok:false, ... }
 *   - GET  /heybox/img?u=…         → 图片/媒体字节(仅 *.xiaoheihe.cn / *.max-c.com)
 *
 * 签名与公共参数完全照抄 heybox 的 src/api/client.ts + signature.ts,保证服务端
 * 认账。Cookie 只落 $DSH_HOME/heybox/state.json,永不下发浏览器。
 *
 * @module heybox
 */
import { searchPostingSelections } from "./posting-selections.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Automation } from "./automation.js";
import { createHostSlangGenerator } from "./slang-host.js";
import { QrLogin } from "./login.js";
import { Dependencies } from "./dependencies.js";
import { platformText } from "./platform-error.js";

const PACKAGE_VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const API_BASE = "https://api.xiaoheihe.cn";
const REFERER = "https://www.xiaoheihe.cn/";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const TIMEOUT_MS = 20000;
const MAX_RPC = 8 * 1024 * 1024; // 大帖子树/评论
const MAX_IMG = 15 * 1024 * 1024;
const MAX_COOKIE = 16 * 1024;

// ---------------------------------------------------------------------------
// 工具:URL / 白名单 / Cookie
// ---------------------------------------------------------------------------

/** 解析并校验 http(s) URL;失败返回 null。 */
export function safeUrl(value) {
  if (!value || typeof value !== "string") return null;
  const text = value.trim();
  if (!/^https?:\/\//i.test(text)) return null;
  try {
    const u = new URL(text);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname) return null;
    return u;
  } catch {
    return null;
  }
}

/**
 * 上游白名单:小黑盒自有域。
 *   - *.xiaoheihe.cn — api/www/bbs/acc…
 *   - *.max-c.com    — CDN(static/imgheybox/cdn…)
 */
export function isAllowedHost(value) {
  const u = safeUrl(value);
  if (!u) return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  const okSuffix = (s) => host === s || host.endsWith("." + s);
  return okSuffix("xiaoheihe.cn") || okSuffix("max-c.com");
}

/** 从 Cookie 里提取 heybox 用户 id(客户端用同一规则校验)。 */
export function heyboxIdFromCookie(cookie) {
  if (!cookie) return null;
  const m = /(?:^|[;\s])heybox_id=(\d+)/i.exec(cookie);
  return m ? m[1] : null;
}

/** 结构校验:必须包含 heybox_id / x_xhh_tokenid / user_pkey 三者之一。 */
export function validateCookie(cookie) {
  if (!cookie || typeof cookie !== "string") return false;
  const trimmed = cookie.trim();
  if (!trimmed) return false;
  return (
    trimmed.includes("heybox_id=") ||
    trimmed.includes("x_xhh_tokenid=") ||
    trimmed.includes("user_pkey=")
  );
}

// ---------------------------------------------------------------------------
// 签名(照抄 heybox src/api/signature.ts,字节级一致)
// ---------------------------------------------------------------------------

const ALPHABET = "AB45STUVWZEFGJ6CH01D237IXYPQRKLMN89";

function md5hex(input) {
  return crypto.createHash("md5").update(input, "utf8").digest("hex");
}
function vm(e) {
  return 128 & e ? 255 & ((e << 1) ^ 27) : e << 1;
}
function qm(e) {
  return vm(e) ^ e;
}
function dollarM(e) {
  return qm(vm(e));
}
function ym(e) {
  return dollarM(qm(vm(e)));
}
function gm(e) {
  return ym(e) ^ dollarM(e) ^ qm(e);
}
function km(e) {
  const t = [0, 0, 0, 0];
  t[0] = gm(e[0]) ^ ym(e[1]) ^ dollarM(e[2]) ^ qm(e[3]);
  t[1] = qm(e[0]) ^ gm(e[1]) ^ ym(e[2]) ^ dollarM(e[3]);
  t[2] = dollarM(e[0]) ^ qm(e[1]) ^ gm(e[2]) ^ ym(e[3]);
  t[3] = ym(e[0]) ^ dollarM(e[1]) ^ qm(e[2]) ^ gm(e[3]);
  e[0] = t[0];
  e[1] = t[1];
  e[2] = t[2];
  e[3] = t[3];
  return e;
}
function av(text, alphabet, offset) {
  let result = "";
  const sliced = alphabet.slice(0, offset);
  for (let i = 0; i < text.length; i++) {
    result += sliced[text.charCodeAt(i) % sliced.length];
  }
  return result;
}
function sv(text, alphabet) {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    result += alphabet[text.charCodeAt(i) % alphabet.length];
  }
  return result;
}
function interleave(arr) {
  let result = "";
  const maxLen = Math.max(...arr.map((s) => s.length));
  for (let i = 0; i < maxLen; i++) {
    for (const s of arr) {
      if (i < s.length) result += s[i];
    }
  }
  return result;
}
export function ov(path, timestamp, nonce) {
  const normalizedPath = "/" + path.split("/").filter((s) => s).join("/") + "/";
  const encT = av(String(timestamp), ALPHABET, -2);
  const encP = sv(normalizedPath, ALPHABET);
  const encN = sv(nonce, ALPHABET);
  const interleaved = interleave([encT, encP, encN]).slice(0, 20);
  const hash = md5hex(interleaved);
  const last6 = hash
    .slice(-6)
    .split("")
    .map((ch) => ch.charCodeAt(0));
  const transformed = km([...last6]);
  let checksum = String(transformed.reduce((sum, val) => sum + val, 0) % 100);
  if (checksum.length < 2) checksum = "0" + checksum;
  const prefix = av(hash.substring(0, 5), ALPHABET, -4);
  return prefix + checksum;
}
export function generateSignature(apiPath) {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = md5hex(timestamp + Math.random().toString()).toUpperCase();
  const hkey = ov(apiPath, timestamp + 1, nonce);
  return { hkey, _time: timestamp, nonce };
}

// ---------------------------------------------------------------------------
// 账号状态(主机侧存储)
// ---------------------------------------------------------------------------

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}
function statePath() {
  return path.join(dshHome(), "heybox", "state.json");
}
function readState() {
  try {
    const raw = fs.readFileSync(statePath(), "utf8");
    const j = JSON.parse(raw);
    if (j && typeof j === "object") {
      fs.chmodSync(statePath(), 0o600);
      return j;
    }
  } catch {
    /* no state yet */
  }
  return {};
}
function writeState(next) {
  const file = statePath();
  const temp = file + "." + crypto.randomUUID() + ".tmp";
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
  } catch {
    /* memory-only fallback */
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

// ---------------------------------------------------------------------------
// 网络
// ---------------------------------------------------------------------------

async function readBody(req, cap = 1024 * 1024) {
  try {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > cap) throw new Error("body too large");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return null;
  }
}

async function upstream(url, { method = "GET", headers = {}, body = null, maxBytes = MAX_RPC } = {}) {
  const r = await fetch(url, {
    method,
    headers: Object.assign(
      {
        "User-Agent": UA,
        Accept: "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        Referer: REFERER,
        Origin: "https://www.xiaoheihe.cn",
      },
      headers,
    ),
    body: body && method !== "GET" ? body : undefined,
    // Do not let an allowed upstream redirect credentials or media to another host.
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const out = { status: r.status, ok: r.ok, headers: r.headers };
  if (r.body) {
    const reader = r.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("too large");
      }
      chunks.push(Buffer.from(value));
    }
    out.buffer = Buffer.concat(chunks);
  } else {
    out.buffer = Buffer.alloc(0);
  }
  return out;
}

/** 构建与 heybox 完全一致的带签名请求 URL。 */
function buildSignedUrl(state, pathName, extraParams) {
  const sig = generateSignature(pathName);
  if (pathName === "/bbs/app/comment/create") {
    // Public web-client signing constant, not a user API key. See issue #1.
    const signingKey = "Z7mFG4tQp9Ws2LxB8H"; // gitleaks:allow -- public protocol constant, not account credentials
    const rnd = "15:" + crypto.createHmac("sha256", signingKey)
      .update(`${signingKey}${sig.nonce}${sig._time}:${sig.nonce}`).digest("hex");
    return API_BASE + pathName + "?" + new URLSearchParams({
      app:"heybox", os_type:"web", x_app:"heybox_website", x_client_type:"web",
      x_os_type:"Windows", x_client_version:"", client_type:"web", web_version:"3.0", version:"999.0.4",
      hkey:sig.hkey, _time:String(sig._time), nonce:sig.nonce, _rnd:rnd,
    });
  }
  const common = {
    os_type: "web",
    app: "heybox",
    client_type: "web",
    version: "999.0.4",
    web_version: "2.5",
    x_client_type: "web",
    x_app: "heybox_website",
    heybox_id: state.heyboxId || "",
    x_os_type: "Windows",
    device_info: "Chrome",
    device_id: state.deviceId,
  };
  const params = Object.assign(
    {},
    common,
    { hkey: sig.hkey, _time: String(sig._time), nonce: sig.nonce },
    extraParams || {},
  );
  return (
    API_BASE +
    pathName +
    "?" +
    Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&")
  );
}

// Keep the complete receipt: create-comment IDs may be outside `result`.
export async function requestHeybox(state, pathName, params = {}, method = "GET", form = null) {
  const headers = { Cookie: state.cookie };
  if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded;charset=utf-8";
  const response = await upstream(buildSignedUrl(state, pathName, params), {
    method, headers, body: method === "POST" ? new URLSearchParams(form || {}).toString() : null,
  });
  const secrets = [state.cookie, ...(state.cookie || "").split(";").map((part) => part.slice(part.indexOf("=") + 1).trim())];
  let data;
  try { data = JSON.parse(response.buffer.toString("utf8")); } catch {
    const error = new Error("平台返回非 JSON 数据");
    error.httpStatus = response.status;
    error.kind = response.status === 401 ? "authentication" : response.status === 429 ? "rate_limit" : "api";
    throw error;
  }
  if (!response.ok || data?.status !== "ok") {
    const error = new Error(["login", "relogin"].includes(data?.status) ? "Cookie 已过期，请重新登录" : "小黑盒 API 请求失败");
    error.kind = ["login", "relogin"].includes(data?.status) || response.status === 401 ? "authentication"
      : data?.status === "show_captcha" ? "captcha"
      : response.status === 429 || ["rate_limit", "too_many_requests", "429"].includes(data?.status) ? "rate_limit" : "api";
    error.definitive = response.ok && typeof data?.status === "string" && data.status !== "ok";
    error.httpStatus = response.status;
    error.platformStatus = platformText(data?.status, secrets, 80);
    error.platformMessage = platformText(data?.msg, secrets);
    if (error.platformMessage) error.message += "：" + error.platformMessage;
    throw error;
  }
  return data;
}

// ---------------------------------------------------------------------------
// 消息中心（只读）
// ---------------------------------------------------------------------------

const MESSAGE_PATH = "/bbs/app/user/message";
const MESSAGE_PAGE_SIZE = 20;
const MESSAGE_TEXT_LIMIT = 4000;
const MESSAGE_CONTEXT_LIMIT = 1000;
const MESSAGE_TYPE_NAMES = Object.freeze({ 1: "reply", 2: "comment" });
const MESSAGE_TYPE_LABELS = Object.freeze({ reply: "回复", comment: "评论" });

function sendJson(res, code, obj) {
  if (!res.headersSent) res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

/** 消息分页参数只接受显式非负整数；limit 上限 50，避免一次拉取过多。 */
export function parseMessagePage(searchParams) {
  const offsetText = searchParams?.get ? searchParams.get("offset") : null;
  const limitText = searchParams?.get ? searchParams.get("limit") : null;
  if (offsetText !== null && !/^\d+$/.test(offsetText)) throw new Error("offset 必须为非负整数");
  if (limitText !== null && !/^\d+$/.test(limitText)) throw new Error("limit 必须为 1–50 的整数");
  const offset = offsetText === null ? 0 : Number(offsetText);
  const limit = limitText === null ? MESSAGE_PAGE_SIZE : Number(limitText);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset 必须为非负整数");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("limit 必须在 1–50 之间");
  return { offset, limit };
}

function scalarText(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}
function messageId(value) {
  const text = scalarText(value);
  return text && text.length <= 64 ? text : "";
}
function messageText(value, max) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  let text = String(value).replace(/\0/g, "").trim();
  if (!text) return "";
  text = text.replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
  return text.slice(0, max);
}
function messageTimestamp(message) {
  for (const key of ["timestamp", "create_at", "created_at", "time", "ctime", "at"]) {
    const value = message[key];
    if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
    if (typeof value === "string" && value.trim()) {
      if (/^\d+$/.test(value.trim())) {
        const number = Number(value.trim());
        return number < 1e12 ? number * 1000 : number;
      }
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}
function booleanFlag(value) {
  if (typeof value === "boolean") return value;
  const text = scalarText(value).toLowerCase();
  if (["1", "true", "yes", "unread"].includes(text)) return true;
  if (["0", "false", "no", "read"].includes(text)) return false;
  return null;
}
function messageReadState(message) {
  let isRead = null;
  for (const key of ["is_unread", "unread"]) {
    const value = booleanFlag(message[key]);
    if (value !== null) return { isRead: !value, readState: scalarText(message[key]) };
  }
  for (const key of ["is_read", "has_read", "read_status"]) {
    const value = booleanFlag(message[key]);
    if (value !== null) return { isRead: value, readState: scalarText(message[key]) };
  }
  return { isRead, readState: scalarText(message.state ?? message.read_state) };
}

/**
 * 只保留前端需要的字段。真实接口可能以 user_a / comment_a_text / link.linkid
 * 等形式出现；缺失字段留空，但不丢弃整条消息。
 */
export function normalizeMessage(raw) {
  const message = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const link = message.link && typeof message.link === "object" && !Array.isArray(message.link) ? message.link : {};
  const userA = message.user_a && typeof message.user_a === "object" ? message.user_a : {};
  const userB = message.user_b && typeof message.user_b === "object" ? message.user_b : {};
  const rawType = scalarText(message.message_type ?? message.type ?? message.msg_type);
  const type = MESSAGE_TYPE_NAMES[rawType] || "unknown";
  const timestamp = messageTimestamp(message);
  const read = messageReadState(message);
  return {
    messageId: messageId(message.message_id ?? message.msg_id ?? message.id),
    type,
    typeCode: rawType,
    typeLabel: MESSAGE_TYPE_LABELS[type] || "其他通知",
    senderName: messageText(userA.username ?? userA.nickname ?? userB.username ?? userB.nickname, 80),
    senderId: messageId(userA.userid ?? userA.heybox_id ?? userA.user_id ?? message.userid_a ?? userB.userid ?? userB.heybox_id ?? userB.user_id),
    text: messageText(message.comment_a_text ?? message.text ?? message.content ?? message.message ?? message.msg, MESSAGE_TEXT_LIMIT),
    contextText: messageText(message.comment_b_text ?? message.quote_text ?? message.parent_text, MESSAGE_CONTEXT_LIMIT),
    timestamp,
    postId: messageId(link.linkid ?? link.link_id ?? message.linkid ?? message.link_id),
    postTitle: messageText(link.title ?? message.link_title ?? message.post_title, 400),
    commentId: messageId(message.comment_a_id ?? message.comment_id ?? message.commentid),
    rootCommentId: messageId(message.root_comment_id ?? message.root_id),
    isRead: read.isRead,
    readState: read.readState,
  };
}

function messageHasMore(box, count, limit) {
  const positive = ["has_more", "hasMore", "more"];
  for (const key of positive) {
    const value = booleanFlag(box[key]);
    if (value !== null) return value;
  }
  for (const key of ["no_more", "noMore", "is_end", "isEnd"]) {
    const value = booleanFlag(box[key]);
    if (value !== null) return !value;
  }
  return count >= limit;
}

export function normalizeMessagesPage(box, offset, limit) {
  const result = box && typeof box === "object" && !Array.isArray(box) ? box : {};
  const list = Array.isArray(result.messages) ? result.messages : Array.isArray(result.list) ? result.list : [];
  const messages = list.slice(0, limit).map(normalizeMessage);
  return {
    count: messages.length,
    messages,
    hasMore: messages.length ? messageHasMore(result, messages.length, limit) : false,
    nextOffset: offset + messages.length,
  };
}

const REPLY_TYPE_LABELS = Object.freeze({ comment: "帖子评论", reply: "评论回复" });
const REPLY_STATUS_LABELS = Object.freeze({ sent: "已发送", accepted: "已受理", unknown: "结果未知" });
const REPLY_VISIBLE_STATUSES = new Set(["sent", "accepted", "unknown"]);

/** 本地发送记录只保留展示所需字段，不返回内部动作键或认证数据。 */
export function normalizeReply(record) {
  const item = record && typeof record === "object" && !Array.isArray(record) ? record : {};
  const type = item.kind === "reply" ? "reply" : item.kind === "comment" ? "comment" : "unknown";
  const status = scalarText(item.status) || "unknown";
  return {
    replyId: messageId(item.replyId),
    commentId: messageId(item.commentId),
    type,
    typeLabel: REPLY_TYPE_LABELS[type] || "其他记录",
    status,
    statusLabel: REPLY_STATUS_LABELS[status] || "状态未知",
    text: messageText(item.displayText ?? item.text, MESSAGE_TEXT_LIMIT),
    contextText: messageText(item.incoming, MESSAGE_CONTEXT_LIMIT),
    timestamp: Number.isFinite(item.at) ? item.at : null,
    postId: messageId(item.postId),
    postTitle: messageText(item.title, 400),
  };
}

/** 只展示已发送/已受理/结果未知的记录；拒绝和跳过不是已发布的回复。 */
export function normalizeReplyPage(records, offset, limit) {
  const list = (Array.isArray(records) ? records : [])
    .filter((record) => REPLY_VISIBLE_STATUSES.has(String(record?.status || "")))
    .sort((a, b) => (Number(b?.at) || 0) - (Number(a?.at) || 0));
  const page = list.slice(offset, offset + limit);
  return {
    total: list.length,
    count: page.length,
    replies: page.map(normalizeReply),
    hasMore: offset + page.length < list.length,
    nextOffset: offset + page.length,
  };
}

/**
 * GET /heybox/replies 的处理器。数据来自本机 automation 发送记录，不访问
 * 上游，也不会修改队列、发送状态或任何账号数据。
 */
export function createRepliesHandler({ getState, getAutomation } = {}) {
  return async function repliesHandler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "GET only" });
    const state = getState();
    if (!state?.cookie || !validateCookie(state.cookie)) {
      return sendJson(res, 401, { ok: false, code: "relogin", error: "未登录或登录已失效，请先登录小黑盒" });
    }
    let page;
    try {
      page = parseMessagePage(new URL(req.url || "/", "http://localhost").searchParams);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
    try {
      const status = getAutomation().status();
      return sendJson(res, 200, { ok: true, offset: page.offset, limit: page.limit, ...normalizeReplyPage(status.interactions, page.offset, page.limit) });
    } catch {
      return sendJson(res, 502, { ok: false, error: "读取发送记录失败" });
    }
  };
}

/**
 * GET /heybox/messages 的处理器。请求通过 createMessageHandler 注入的
 * request 完成，测试可离线替换；这里从不调用写接口。
 */
export function createMessageHandler({ getState, request = requestHeybox } = {}) {
  return async function messagesHandler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "GET only" });
    const state = getState();
    if (!state?.cookie || !validateCookie(state.cookie)) {
      return sendJson(res, 401, { ok: false, code: "relogin", error: "未登录或登录已失效，请先登录小黑盒" });
    }
    let page;
    try {
      page = parseMessagePage(new URL(req.url || "/", "http://localhost").searchParams);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
    try {
      const data = await request(state, MESSAGE_PATH, {
        list_type: "0",
        offset: String(page.offset),
        limit: String(page.limit),
        no_more: "false",
      });
      const box = data?.result ?? data ?? {};
      return sendJson(res, 200, { ok: true, offset: page.offset, limit: page.limit, ...normalizeMessagesPage(box, page.offset, page.limit) });
    } catch (e) {
      if (e?.kind === "authentication") return sendJson(res, 401, { ok: false, code: "relogin", error: "登录已失效，请重新登录小黑盒" });
      if (e?.kind === "rate_limit") return sendJson(res, 429, { ok: false, error: "消息读取过于频繁，请稍后重试" });
      if (e?.kind === "captcha") return sendJson(res, 403, { ok: false, error: "平台要求人机验证，请完成验证后重试" });
      return sendJson(res, 502, { ok: false, error: e?.message || "消息读取失败" });
    }
  };
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

export const inject = ["webServer"];

export function apply(ctx) {
  const webServer = ctx.webServer;
  if (webServer === undefined) return;

  let state = readState();
  if (!state.deviceId) {
    state.deviceId = crypto.randomBytes(16).toString("hex");
    writeState(state);
  }

  const json = (res, code, obj) => {
    if (!res.headersSent) res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  };
  const publicState = () => ({
    loggedIn: !!(state.cookie && state.cookie.length > 0),
    deviceId: state.deviceId,
    heyboxId: state.heyboxId || heyboxIdFromCookie(state.cookie) || null,
  });
  const automation = new Automation({
    directory: path.join(dshHome(), "heybox"),
    account: () => state.cookie ? {
      id: state.heyboxId || heyboxIdFromCookie(state.cookie),
      identity: crypto.createHash("sha256").update(state.cookie).digest("hex"),
      cookie: state.cookie, heyboxId: state.heyboxId, deviceId: state.deviceId,
    } : null,
    api: requestHeybox,
    generate: createHostSlangGenerator(ctx),
    search: async (request,signal) => {
      const web = typeof ctx.get === "function" ? ctx.get("web") : ctx.web;
      if (typeof web?.search !== "function") throw Object.assign(new Error("DSH 搜索服务未配置"),{code:"WEB_SERVICE_UNAVAILABLE"});
      return web.search(request,signal);
    },
  });
  ctx.effect(() => automation.start());

  const qrLogin = new QrLogin({
    directory: path.join(dshHome(), "heybox"),
    request: async (endpoint, params, cookie) => {
      const response = await upstream(buildSignedUrl({ deviceId: state.deviceId }, endpoint, params), { headers: cookie ? { Cookie: cookie } : {}, maxBytes: 128 * 1024 });
      if (!response.ok) throw new Error("小黑盒登录服务暂不可用，请重试");
      let data;
      try { data = JSON.parse(response.buffer.toString("utf8")); } catch { throw new Error("登录服务返回无效响应"); }
      const cookies = response.headers.getSetCookie?.() || (response.headers.get("set-cookie") || "").split(/,(?=\s*[\w-]+=)/).filter(Boolean);
      return { data, cookies };
    },
    authenticate: ({ cookie, heyboxId }) => {
      automation.cancel();
      const next = { ...state, cookie, heyboxId, loggedInAt: Date.now() };
      const file = statePath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = file + "." + crypto.randomUUID() + ".tmp";
      try { fs.writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 }); fs.renameSync(temp, file); }
      finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
      state = next;
    },
  });
  ctx.effect(() => () => qrLogin.cancel());
  const dependencies = new Dependencies({ directory: path.join(dshHome(), "heybox"), config: () => automation.data.config });
  ctx.effect(() => () => dependencies.close());
  webServer.register({
    kind: "prefix", path: "/heybox/dependencies",
    handler: async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      try {
        if (req.method === "GET") return json(res, 200, { ok: true, ...dependencies.status() });
        if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST only" });
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return json(res, 403, { ok: false, error: "origin mismatch" });
        if (!String(req.headers["content-type"] || "").startsWith("application/json")) return json(res, 415, { ok: false, error: "application/json required" });
        const payload = JSON.parse(await readBody(req, 4096) || "{}");
        if (payload.action !== "install") return json(res, 400, { ok: false, error: "unknown action" });
        return json(res, 202, { ok: true, ...dependencies.install() });
      } catch (e) { json(res, 400, { ok: false, error: e.message }); }
    },
  });
  webServer.register({
    kind: "prefix", path: "/heybox/login",
    handler: async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      try {
        if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST only" });
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return json(res, 403, { ok: false, error: "origin mismatch" });
        if (!String(req.headers["content-type"] || "").startsWith("application/json")) return json(res, 415, { ok: false, error: "application/json required" });
        const payload = JSON.parse(await readBody(req, 32768) || "{}");
        if (payload.action === "start") return json(res, 200, { ok: true, ...await qrLogin.start() });
        if (payload.action === "poll") return json(res, 200, { ok: true, ...await qrLogin.poll(payload.sessionId) });
        if (payload.action === "cancel") { qrLogin.cancelSession(payload.sessionId); return json(res, 200, { ok: true }); }
        return json(res, 400, { ok: false, error: "unknown action" });
      } catch { return json(res, 400, { ok: false, error: "扫码登录失败，请重试或使用 Cookie 备用登录" }); }
    },
  });

  webServer.register({
    kind: "prefix", path: "/heybox/posting-selections",
    handler: async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      if (req.method !== "GET") return json(res, 405, { ok: false, error: "GET only" });
      if (!state.cookie) return json(res, 401, { ok: false, error: "请先登录小黑盒，再搜索分区和话题" });
      try {
        const q = new URL(req.url, "http://localhost").searchParams.get("q") || "";
        const result = await searchPostingSelections({ ...state }, requestHeybox, q);
        return json(res, 200, { ok: true, ...result });
      } catch { return json(res, 400, { ok: false, error: "分区和话题查询失败，请检查登录或缩短搜索词后重试" }); }
    },
  });

  webServer.register({
    kind: "prefix", path: "/heybox/automation",
    handler: async (req, res) => {
      try {
        if (req.method === "GET") return json(res, 200, { ok: true, ...automation.status() });
        if (req.method !== "POST") return json(res, 405, { ok:false, error:"POST only" });
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
          return json(res, 403, { ok:false, error:"origin mismatch" });
        }
        if (!String(req.headers["content-type"] || "").startsWith("application/json")) return json(res,415,{ok:false,error:"application/json required"});
        const payload = JSON.parse(await readBody(req) || "{}");
        if (payload.action === "post-now") {
          automation.run("post",{manual:true,accountId:payload.accountId,requestId:payload.requestId}).catch(() => {});
          return json(res,202,{ok:true,...automation.status()});
        }
        if (payload.action === "run") {
          automation.run(payload.kind || "browse").catch(() => {});
          return json(res,202,{ok:true,...automation.status()});
        }
        if (payload.action !== "configure") return json(res,400,{ok:false,error:"unknown action"});
        return json(res,200,{ok:true,...automation.configure(payload.config)});
      } catch(e) { json(res,400,{ok:false,error:e.message}); }
    },
  });

  webServer.register({
    kind: "prefix", path: "/heybox/slang",
    handler: async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      try {
        if (req.method === "GET") return json(res, 200, { ok:true, ...automation.status().slang });
        if (req.method !== "POST") return json(res, 405, { ok:false, error:"POST only" });
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return json(res, 403, { ok:false, error:"origin mismatch" });
        if (!String(req.headers["content-type"] || "").startsWith("application/json")) return json(res, 415, { ok:false, error:"application/json required" });
        const payload = JSON.parse(await readBody(req, 8192) || "{}");
        if (payload.action === "stop") return json(res,200,{ok:true,...automation.stopSlang(payload)});
        if (["extract","research"].includes(payload.action)) return json(res,202,{ok:true,...automation.runSlang(payload)});
        return json(res, 200, { ok:true, ...automation.editSlang(payload) });
      } catch (e) { json(res, 400, { ok:false, error:e.message }); }
    },
  });

  webServer.register({
    kind: "prefix", path: "/heybox/watched",
    handler: (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      if (req.method !== "GET") return json(res, 405, { ok: false, error: "GET only" });
      try {
        const params = new URL(req.url, "http://localhost").searchParams;
        return json(res, 200, { ok: true, ...automation.watched({ offset: Number(params.get("offset") || 0), limit: Number(params.get("limit") || 50) }) });
      } catch (e) { json(res, 400, { ok: false, error: e.message }); }
    },
  });

  // 消息中心：只读列表，不标记已读、不写自动回复队列。
  webServer.register({
    kind: "prefix", path: "/heybox/messages",
    handler: createMessageHandler({ getState: () => state }),
  });

  // 我的回复：只读本机发送记录，不访问上游、不改队列。
  webServer.register({
    kind: "prefix", path: "/heybox/replies",
    handler: createRepliesHandler({ getState: () => state, getAutomation: () => automation }),
  });

  // 健康检查
  webServer.register({
    kind: "prefix",
    path: "/heybox/health",
    handler: (_req, res) => json(res, 200, { ok: true, name: "heybox", version: PACKAGE_VERSION }),
  });

  // 账号状态(登录/登出)
  webServer.register({
    kind: "prefix",
    path: "/heybox/state",
    handler: async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      if (!["GET", "POST"].includes(req.method)) return json(res, 405, { ok: false, error: "GET or POST only" });
      if (req.method === "POST") {
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return json(res, 403, { ok: false, error: "origin mismatch" });
        if (!String(req.headers["content-type"] || "").startsWith("application/json")) return json(res, 415, { ok: false, error: "application/json required" });
        const text = await readBody(req);
        if (!text) return json(res, 400, { ok: false, error: "empty body" });
        let payload = null;
        try {
          payload = JSON.parse(text);
        } catch {
          return json(res, 400, { ok: false, error: "bad json" });
        }
        if (payload.action === "login") {
          const cookie = String(payload.cookie || "").trim();
          if (!validateCookie(cookie)) {
            return json(res, 400, {
              ok: false,
              error: "Cookie 无效:需要包含 heybox_id / x_xhh_tokenid / user_pkey",
            });
          }
          if (cookie.length > MAX_COOKIE) return json(res, 400, { ok: false, error: "cookie 过长" });
          qrLogin.cancel();
          automation.cancel();
          state.cookie = cookie;
          state.heyboxId = heyboxIdFromCookie(cookie);
          state.loggedInAt = Date.now();
          writeState(state);
          return json(res, 200, { ok: true, ...publicState() });
        }
        if (payload.action === "logout") {
          qrLogin.cancel();
          automation.cancel();
          delete state.cookie;
          delete state.heyboxId;
          delete state.loggedInAt;
          writeState(state);
          return json(res, 200, { ok: true, ...publicState() });
        }
        return json(res, 400, { ok: false, error: "unknown action" });
      }
      json(res, 200, { ok: true, ...publicState() });
    },
  });

  // 语义 RPC:签名 + 公共参数 + Cookie 全在主机侧。
  webServer.register({
    kind: "prefix",
    path: "/heybox/rpc",
    handler: async (req, res) => {
      try {
        if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST only" });
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return json(res, 403, { ok: false, error: "origin mismatch" });
        if (!String(req.headers["content-type"] || "").startsWith("application/json")) return json(res, 415, { ok: false, error: "application/json required" });
        const text = await readBody(req);
        if (!text) return json(res, 400, { ok: false, error: "empty body" });
        let payload = null;
        try {
          payload = JSON.parse(text);
        } catch {
          return json(res, 400, { ok: false, error: "bad json" });
        }
        const pathName = String(payload.path || "");
        if (!pathName.startsWith("/") || pathName.includes("..")) {
          return json(res, 400, { ok: false, error: "bad path" });
        }
        const method = String(payload.method || "GET").toUpperCase();
        const params = payload.params && typeof payload.params === "object" ? payload.params : {};
        const form = payload.form && typeof payload.form === "object" ? payload.form : null;

        if (!state.cookie || !validateCookie(state.cookie)) {
          return json(res, 200, { ok: false, code: "relogin", msg: "Cookie 缺失或已过期,请重新登录" });
        }

        const url = buildSignedUrl(state, pathName, params);
        const headers = { Cookie: state.cookie };
        let body = null;
        let effectiveMethod = method;
        if (method === "POST") {
          effectiveMethod = "POST";
          headers["Content-Type"] = "application/x-www-form-urlencoded;charset=utf-8";
          body = Object.entries(form || {})
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join("&");
        }

        const r = await upstream(url, { method: effectiveMethod, headers, body, maxBytes: MAX_RPC });
        let data = null;
        try {
          data = JSON.parse(r.buffer.toString("utf8"));
        } catch {
          return json(res, 502, { ok: false, error: "上游返回非 JSON", raw: r.buffer.toString("utf8").slice(0, 200) });
        }
        if (data && data.status === "ok") {
          return json(res, 200, { ok: true, result: data.result ?? null });
        }
        if (data && (data.status === "login" || data.status === "relogin")) {
          return json(res, 200, { ok: false, code: "relogin", msg: data.msg || "Cookie 已过期或无效,请重新登录" });
        }
        return json(res, 200, { ok: false, msg: (data && data.msg) || `API error: ${data && data.status}` });
      } catch (e) {
        json(res, 502, { ok: false, error: String((e && e.message) || e) });
      }
    },
  });

  // 图片/媒体字节(头像、帖子图、评论图)。
  webServer.register({
    kind: "prefix",
    path: "/heybox/img",
    handler: async (req, res) => {
      try {
        const p = new URL(req.url, "http://localhost").searchParams;
        const u = p.get("u");
        if (!u) return json(res, 400, { ok: false, error: "missing u" });
        if (!isAllowedHost(u)) return json(res, 403, { ok: false, error: "host not allowed" });
        const target = safeUrl(u);
        const r = await upstream(target.href, {
          headers: { Referer: REFERER, Accept: "image/avif,image/webp,image/*,*/*;q=0.8" },
          maxBytes: MAX_IMG,
        });
        const ctype = r.headers.get("content-type") || "image/jpeg";
        res.writeHead(r.status, {
          "content-type": ctype,
          "cache-control": "public, max-age=3600",
          "x-content-type-options": "nosniff",
        });
        res.end(r.buffer);
      } catch (e) {
        try {
          if (!res.headersSent) {
            res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
            res.end("img error");
          }
        } catch {
          /* response already gone */
        }
      }
    },
  });
}
