# Companion Contract · 陪伴 agent 接入契约

学不学（LearnOrNot）的「老师来了」聊天栏可以把老师换成你本地运行的陪伴 agent。
你的 agent 不需要是任何一种特定框架——只要它能提供下面两个 HTTP 端点，就能出现在学不学的模型菜单里。

学不学侧的参考实现见 `server/companion.js`。

## 1. 状态端点（在家探测）

```
GET {base}{statusPath}
```

- 返回 2xx → 视为「在家」（菜单里的 chip 亮起）
- 非 2xx / 超时（5 秒）/ 连接拒绝 → 「不在家」（chip 置灰）
- 响应体内容不限（可以是任意 JSON），学不学只看状态码

## 2. 聊天端点（SSE 流式）

```
POST {base}{sendPath}
Content-Type: application/json

{
  "content": "用户在学不学里输入的原话",
  "model_content": "原话 + 学习上下文（在读的书/课节/选中的原文）"
}
```

- **`content`**：用户在学不学聊天栏里打的字，原样。建议把它作为「用户在你们 agent 界面里显示的消息」落库——这样两个系统的聊天记录无缝衔接。
- **`model_content`**：给模型看的增强版。你的 agent 可以完全忽略它（只用 content），也可以用它替换 content 进入 prompt。学不学保证它包含 content 的全部信息。
- **`sendPath` 支持 `{conv}` 占位**：如果你的 agent 是多会话的，把会话 id 填在学不学设置页的「会话 id」里，学不学每次请求会代入。单会话 agent 留空即可。

### 响应：text/event-stream

```
data: {"type":"chunk","content":"增量文本"}\n\n
data: {"type":"chunk","content":"继续"}\n\n
（流关闭即结束）
```

- 只认 `type: "chunk"` 事件的 `content` 字段，**增量**追加；其他事件类型会被忽略
- 学不学会在最终文本里剥离 `<meta>…</meta>` 和 `<think>…</think>` 块（思考过程不展示给学生）；流中未闭合的标签片段会暂扣不显示
- 非 2xx 响应或空流视为失败，聊天栏显示「不在家/没回话」

## 学不学侧的行为

- 每次提问是**独立调用**；多轮记忆由你的 agent 自己负责（它本来就有）
- 学不学会在本地同步存一份聊天记录（用于它自己的历史视图）
- 不会向你的 agent 注入任何人设 prompt——它以本色回答

## 最小 shim 示例（把任意 agent 包成契约）

```js
// 30 行不到：把「我家 agent 的 API」翻译成 Companion Contract
import http from 'node:http';

http.createServer(async (req, res) => {
  if (req.url === '/status') { res.writeHead(200); return res.end('{}'); }
  if (req.url === '/chat' && req.method === 'POST') {
    let raw = '';
    for await (const c of req) raw += c;
    const { content, model_content } = JSON.parse(raw);

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const reply = await myAgent.ask(model_content || content); // 你的 agent
    res.write(`data: ${JSON.stringify({ type: 'chunk', content: reply })}\n\n`);
    return res.end();
  }
  res.writeHead(404); res.end();
}).listen(9123, '127.0.0.1');
```

然后在学不学设置页：名字 `我的伙伴`、地址 `http://127.0.0.1:9123`、状态路径 `/status`、聊天路径 `/chat`、会话 id 留空。完事。
