/** Read-only message center: pagination, normalization and route tests. Offline only. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseMessagePage,
  normalizeMessage,
  normalizeMessagesPage,
  createMessageHandler,
} from "../lib/index.js";

function fakeResponse() {
  return {
    status: 0,
    body: "",
    headers: {},
    headersSent: false,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    writeHead(code, headers) { this.status = code; this.headersSent = true; Object.assign(this.headers, headers || {}); },
    end(body) { this.body = String(body || ""); },
    json() { return JSON.parse(this.body); },
  };
}
function fakeRequest(url, method = "GET") {
  return { url, method, headers: {} };
}
function handlerWith({ state = { cookie: "heybox_id=42; user_pkey=fixture-only", deviceId: "fixture" }, request } = {}) {
  const calls = [];
  const handler = createMessageHandler({
    getState: () => state,
    request: request || (async (...args) => { calls.push(args); return { result: { messages: [] } }; }),
  });
  return { handler, calls };
}

test("pagination defaults, bounds and invalid values", () => {
  assert.deepEqual(parseMessagePage(new URLSearchParams()), { offset: 0, limit: 20 });
  assert.deepEqual(parseMessagePage(new URLSearchParams("offset=35&limit=50")), { offset: 35, limit: 50 });
  assert.deepEqual(parseMessagePage(new URLSearchParams("offset=0&limit=1")), { offset: 0, limit: 1 });
  for (const query of ["offset=-1", "offset=1.5", "offset=abc", "offset=", "offset=1e3", "limit=0", "limit=51", "limit=2.5", "limit=x", "limit="]) {
    assert.throws(() => parseMessagePage(new URLSearchParams(query)), /offset|limit/, query);
  }
});

test("real message fields are normalized without losing optional data", () => {
  const message = normalizeMessage({
    message_id: 4470685575,
    message_type: 1,
    user_a: { username: "示例用户", userid: 8 },
    comment_a_text: "回复 <b>正文</b>",
    comment_b_text: "被回复的原文",
    timestamp: 1793251595,
    linkid: 194874988,
    link_title: "示例帖子",
    comment_a_id: 986982619,
    root_comment_id: 986969315,
    state: 0,
    is_unread: 1,
  });
  assert.deepEqual(message, {
    messageId: "4470685575",
    type: "reply",
    typeCode: "1",
    typeLabel: "回复",
    senderName: "示例用户",
    senderId: "8",
    text: "回复 正文",
    contextText: "被回复的原文",
    timestamp: 1793251595000,
    postId: "194874988",
    postTitle: "示例帖子",
    commentId: "986982619",
    rootCommentId: "986969315",
    isRead: false,
    readState: "1",
  });
});

test("alternate fields, unknown message types and missing fields stay renderable", () => {
  const alternate = normalizeMessage({
    id: "message-2",
    type: 2,
    user_b: { nickname: "另一用户", user_id: 9 },
    text: "备用正文",
    link: { linkid: "42", title: "备用帖子" },
    comment_id: "7",
    root_id: "6",
    create_at: "2026-10-29T00:00:00Z",
    is_read: 1,
  });
  assert.equal(alternate.type, "comment");
  assert.equal(alternate.senderName, "另一用户");
  assert.equal(alternate.senderId, "9");
  assert.equal(alternate.text, "备用正文");
  assert.equal(alternate.postId, "42");
  assert.equal(alternate.postTitle, "备用帖子");
  assert.equal(alternate.isRead, true);
  assert.equal(alternate.timestamp, Date.parse("2026-10-29T00:00:00Z"));

  const unknown = normalizeMessage({ message_id: "m3", message_type: 99, comment_a_text: "未知类型也保留" });
  assert.equal(unknown.type, "unknown");
  assert.equal(unknown.typeCode, "99");
  assert.equal(unknown.typeLabel, "其他通知");
  assert.equal(unknown.text, "未知类型也保留");

  const empty = normalizeMessage({});
  assert.equal(empty.messageId, "");
  assert.equal(empty.senderName, "");
  assert.equal(empty.text, "");
  assert.equal(empty.timestamp, null);
  assert.equal(empty.isRead, null);
  assert.equal(empty.type, "unknown");
});

test("empty pages and has-more fallbacks", () => {
  assert.deepEqual(normalizeMessagesPage({ messages: [] }, 0, 20), {
    count: 0,
    messages: [],
    hasMore: false,
    nextOffset: 0,
  });
  assert.deepEqual(normalizeMessagesPage({}, 40, 20), {
    count: 0,
    messages: [],
    hasMore: false,
    nextOffset: 40,
  });
  assert.equal(normalizeMessagesPage({ messages: Array.from({ length: 20 }, () => ({})) }, 0, 20).hasMore, true);
  assert.equal(normalizeMessagesPage({ messages: [{}], has_more: true }, 0, 20).hasMore, true);
  assert.equal(normalizeMessagesPage({ messages: Array.from({ length: 20 }, () => ({})), no_more: true }, 0, 20).hasMore, false);
});

test("GET handler sends only normalized fields and never a cookie", async () => {
  const { handler, calls } = handlerWith({
    state: { cookie: "heybox_id=42; user_pkey=fixture-secret", deviceId: "fixture" },
    request: async (...args) => {
      calls.push(args);
      return {
        status: "ok",
        result: {
          messages: [{
            message_id: 1, message_type: 1, user_a: { username: "发送者", userid: 8 },
            comment_a_text: "正文", timestamp: 1793251595, linkid: 2, link_title: "帖子",
            comment_a_id: 3, root_comment_id: 4, state: 0,
          }],
        },
      };
    },
  });
  const res = fakeResponse();
  await handler(fakeRequest("/heybox/messages?offset=3&limit=20"), res);
  const body = res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.offset, 3);
  assert.equal(body.limit, 20);
  assert.equal(body.count, 1);
  assert.equal(body.messages[0].senderName, "发送者");
  assert.equal(body.hasMore, false);
  assert.equal(body.nextOffset, 4);
  assert.ok(!JSON.stringify(body).includes("fixture-secret"));
  assert.ok(!("cookie" in body));
  assert.deepEqual(calls[0][2], { list_type: "0", offset: "3", limit: "20", no_more: "false" });
  assert.equal(calls[0][1], "/bbs/app/user/message");
});

test("unauthenticated and invalid pagination requests fail before upstream", async () => {
  const auth = handlerWith({ state: {} });
  let res = fakeResponse();
  await auth.handler(fakeRequest("/heybox/messages"), res);
  assert.equal(res.status, 401);
  assert.equal(res.json().code, "relogin");
  assert.match(res.json().error, /登录/);
  assert.equal(auth.calls.length, 0);

  const invalid = handlerWith();
  res = fakeResponse();
  await invalid.handler(fakeRequest("/heybox/messages?offset=-1"), res);
  assert.equal(res.status, 400);
  assert.match(res.json().error, /offset/);
  assert.equal(invalid.calls.length, 0);

  res = fakeResponse();
  await invalid.handler(fakeRequest("/heybox/messages?limit=51"), res);
  assert.equal(res.status, 400);
  assert.match(res.json().error, /limit/);
  assert.equal(invalid.calls.length, 0);

  res = fakeResponse();
  await invalid.handler(fakeRequest("/heybox/messages", "POST"), res);
  assert.equal(res.status, 405);
  assert.equal(invalid.calls.length, 0);
});

test("empty upstream list and upstream authentication errors are explicit", async () => {
  const empty = handlerWith();
  let res = fakeResponse();
  await empty.handler(fakeRequest("/heybox/messages"), res);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json().messages, []);
  assert.equal(res.json().count, 0);

  const expired = handlerWith({ request: async () => { throw Object.assign(new Error("Cookie 已过期"), { kind: "authentication" }); } });
  res = fakeResponse();
  await expired.handler(fakeRequest("/heybox/messages"), res);
  assert.equal(res.status, 401);
  assert.equal(res.json().code, "relogin");
  assert.match(res.json().error, /重新登录/);

  const limited = handlerWith({ request: async () => { throw Object.assign(new Error("too many"), { kind: "rate_limit" }); } });
  res = fakeResponse();
  await limited.handler(fakeRequest("/heybox/messages"), res);
  assert.equal(res.status, 429);
  assert.match(res.json().error, /频繁/);
});
