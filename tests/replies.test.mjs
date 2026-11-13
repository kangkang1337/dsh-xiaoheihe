/** "我的回复" local outgoing records: normalization, pagination and read-only route tests. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeReply,
  normalizeReplyPage,
  createRepliesHandler,
  rpcWriteRecord,
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
function handlerWith({ state = { cookie: "heybox_id=42; user_pkey=fixture-only" }, status = { interactions: [] } } = {}) {
  return createRepliesHandler({
    getState: () => state,
    getAutomation: () => ({ status: () => status }),
  });
}

test("outgoing reply fields are normalized and kept display-only", () => {
  const reply = normalizeReply({
    kind: "reply",
    status: "sent",
    at: 1793251595000,
    postId: 194874988,
    title: "原帖标题",
    displayText: "@作者 已发送正文",
    text: "<a data-user-id=\"8\">@作者</a> 已发送正文",
    incoming: "对方原文",
    commentId: 986982619,
    replyId: 986969315,
    apiKey: "should-not-leak",
  });
  assert.deepEqual(reply, {
    replyId: "986969315",
    commentId: "986982619",
    type: "reply",
    typeLabel: "评论回复",
    status: "sent",
    statusLabel: "已发送",
    text: "@作者 已发送正文",
    contextText: "对方原文",
    timestamp: 1793251595000,
    postId: "194874988",
    postTitle: "原帖标题",
  });
  assert.ok(!JSON.stringify(reply).includes("should-not-leak"));
});

test("pagination filters failed attempts, sorts newest first and reports hasMore", () => {
  const records = [
    { kind: "comment", status: "sent", at: 100, postId: "1", displayText: "旧" },
    { kind: "reply", status: "rejected", at: 300, postId: "3", displayText: "拒绝" },
    { kind: "reply", status: "unknown", at: 200, postId: "2", displayText: "未知" },
    { kind: "comment", status: "skipped", at: 400, postId: "4", displayText: "跳过" },
    { kind: "comment", status: "accepted", at: 50, postId: "5", displayText: "受理" },
  ];
  const first = normalizeReplyPage(records, 0, 2);
  assert.equal(first.total, 3);
  assert.equal(first.count, 2);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextOffset, 2);
  assert.deepEqual(first.replies.map((item) => item.text), ["未知", "旧"]);
  const second = normalizeReplyPage(records, 2, 2);
  assert.equal(second.count, 1);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextOffset, 3);
  assert.equal(second.replies[0].text, "受理");
  assert.deepEqual(records.map((item) => item.at), [100, 300, 200, 400, 50], "sorting must not mutate source");
});

test("missing fields remain renderable and empty lists are stable", () => {
  const reply = normalizeReply({});
  assert.equal(reply.commentId, "");
  assert.equal(reply.replyId, "");
  assert.equal(reply.text, "");
  assert.equal(reply.timestamp, null);
  assert.equal(reply.type, "unknown");
  assert.deepEqual(normalizeReplyPage([], 0, 20), {
    total: 0, count: 0, replies: [], hasMore: false, nextOffset: 0,
  });
  assert.deepEqual(normalizeReplyPage(null, 40, 20), {
    total: 0, count: 0, replies: [], hasMore: false, nextOffset: 40,
  });
});

test("GET /heybox/replies returns only normalized local records", async () => {
  const handler = handlerWith({
    status: {
      interactions: [
        { kind: "reply", status: "sent", at: 200, postId: "2", title: "帖子二", displayText: "回复正文", commentId: "22", replyId: "21", incoming: "对方" },
        { kind: "comment", status: "accepted", at: 100, postId: "1", title: "帖子一", displayText: "评论正文" },
      ],
      apiKey: "must-not-leak",
      config: { apiKey: "must-not-leak" },
    },
  });
  const res = fakeResponse();
  await handler(fakeRequest("/heybox/replies?offset=0&limit=20"), res);
  const body = res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.count, 2);
  assert.equal(body.total, 2);
  assert.equal(body.hasMore, false);
  assert.equal(body.replies[0].type, "reply");
  assert.equal(body.replies[0].postTitle, "帖子二");
  assert.equal(body.replies[0].contextText, "对方");
  assert.equal(body.replies[1].statusLabel, "已受理");
  assert.ok(!JSON.stringify(body).includes("must-not-leak"));
  assert.ok(!JSON.stringify(body).includes("fixture-only"));
  assert.ok(!("config" in body));
});

test("read-only handler rejects unauthenticated, invalid and non-GET requests", async () => {
  const auth = handlerWith({ state: {} });
  let res = fakeResponse();
  await auth(fakeRequest("/heybox/replies"), res);
  assert.equal(res.status, 401);
  assert.match(res.json().error, /登录/);

  const handler = handlerWith();
  res = fakeResponse();
  await handler(fakeRequest("/heybox/replies?offset=-1"), res);
  assert.equal(res.status, 400);
  assert.match(res.json().error, /offset/);

  res = fakeResponse();
  await handler(fakeRequest("/heybox/replies?limit=51"), res);
  assert.equal(res.status, 400);
  assert.match(res.json().error, /limit/);

  res = fakeResponse();
  await handler(fakeRequest("/heybox/replies", "POST"), res);
  assert.equal(res.status, 405);
  assert.equal(res.json().error, "GET only");
});

test("successful RPC comment, reply and post writes become reply records", () => {
  const comment = rpcWriteRecord("/bbs/app/comment/create", { link_id: "1", reply_id: "-1", text: "评论" }, { status: "ok", commentid: 9 }, 100);
  assert.deepEqual(comment, {
    kind: "comment", status: "sent", postId: "1", commentId: "9", replyId: "", text: "评论", displayText: "评论", at: 100,
  });
  const reply = rpcWriteRecord("/bbs/app/comment/create", { link_id: "1", reply_id: "8", text: "回复" }, { status: "ok", result: { commentid: 10 } }, 200);
  assert.equal(reply.kind, "reply");
  assert.equal(reply.replyId, "8");
  assert.equal(reply.commentId, "10");
  const post = rpcWriteRecord("/bbs/app/api/link/post", { title: "标题", text: JSON.stringify([{ type: "text", text: "正文" }]) }, { status: "ok", result: { link_id: 11 } }, 300);
  assert.deepEqual(post, {
    kind: "post", status: "sent", postId: "11", title: "标题", text: "正文", at: 300,
  });
  assert.equal(rpcWriteRecord("/bbs/app/api/link/post", {}, { status: "failed" }), null);
  assert.equal(rpcWriteRecord("/bbs/app/feeds", {}, { status: "ok" }), null);
  assert.equal(rpcWriteRecord("/bbs/app/comment/create", null, { status: "ok" }), null);
});

test("RPC posts are labeled as posts and included in pagination", () => {
  const page = normalizeReplyPage([
    { kind: "post", status: "sent", postId: "7", title: "帖子标题", text: "帖子正文", at: 10 },
    { kind: "comment", status: "sent", postId: "1", commentId: "2", text: "评论", at: 20 },
  ], 0, 20);
  assert.equal(page.count, 2);
  assert.equal(page.replies[0].type, "comment");
  assert.equal(page.replies[1].type, "post");
  assert.equal(page.replies[1].typeLabel, "帖子");
  assert.equal(page.replies[1].postTitle, "帖子标题");
  assert.equal(page.replies[1].text, "帖子正文");
});

test("local record read failure stays a generic read-only error", async () => {
  const handler = createRepliesHandler({
    getState: () => ({ cookie: "heybox_id=42; user_pkey=fixture-only" }),
    getAutomation: () => ({ status: () => { throw new Error("secret internals"); } }),
  });
  const res = fakeResponse();
  await handler(fakeRequest("/heybox/replies"), res);
  assert.equal(res.status, 502);
  assert.equal(res.json().error, "读取发送记录失败");
  assert.ok(!res.body.includes("secret internals"));
});
