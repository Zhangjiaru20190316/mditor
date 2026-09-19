// 本地单测（hypium）——纯逻辑锚定（N22 第三批补强）：
//   UriMapper：token 分配/幂等挂载、虚拟路径解析（/AppData、/Docs/<token>/<rel>，
//              含中文与特殊字符编码）、未知 token 报错、tryResolve 软失败；
//   AiBridge：SSE data 帧解析（parseStreamChunk，含 [DONE]/非 JSON 容错与
//             reasoning 字段优先级）、tool_calls 分片聚合（mergeToolCallDeltas）
//             与收尾（finalizeToolCalls）；
//   S3Bridge：key 校验（validateKeyError）、HTTP 状态/错误码映射
//             （mapStatusError）、XML 实体还原与 etag 去引号（xmlDecode /
//             stripEtagQuotes）。
//
// 被测函数均为模块顶层导出纯函数（AiBridge/S3Bridge 文件尾部的桥类不在此
// 覆盖——hypium 本地宿主无网络/沙箱，kit API 调用路径不在本文件范围）。
// 例外：parseListXml 内部经 util.TextEncoder 触 kit API（本地 stub 下解析
// 恒空，实锤见 task-W8 记录），其用例只能上真机/模拟器 OnDevice Test。
// 本地测试环境无真实沙箱：UriMapper 的 load/persist 均 fail-soft（fs 异常
// 被吞、内存映射照常工作），因此逻辑路径可完全离线验证。
//
// 执行：hvigorw --mode module -p module=entry@default -p isLocalTest=true test
//（或 DevEco「Local Test」）。注意：hvigor 对断言失败不置 BUILD FAILURE，
// 须读日志中的 ERROR 行 / GenerateUnitTestResult 报告判定通过与否。

import { describe, it, expect } from '@ohos/hypium';
import { UriMapper } from '../main/ets/io/UriMapper';
import { parseStreamChunk, mergeToolCallDeltas, finalizeToolCalls, AggToolCall }
  from '../main/ets/ai/AiBridge';
import { validateKeyError, mapStatusError, xmlDecode, stripEtagQuotes } from '../main/ets/net/S3Bridge';

export default function localUnitTests() {
  describe('UriMapper', () => {
    it('mountRoot 分配递增 token 且幂等（同 URI 复用）', 0, () => {
      const m = new UriMapper('/tmp/mditor-test');
      const a = m.mountRoot('file://docs/storage/Users/x/Docs/notes', 'notes');
      const b = m.mountRoot('file://docs/storage/Users/x/Docs/notes', 'notes');
      const c = m.mountRoot('file://docs/storage/Users/x/Docs/other', 'other');
      expect(a).assertEqual('/Docs/ws-1');
      expect(b).assertEqual('/Docs/ws-1');
      expect(c).assertEqual('/Docs/ws-2');
    });

    it('resolve /AppData 前缀映射沙箱路径', 0, () => {
      const m = new UriMapper('/tmp/mditor-test');
      const r = m.resolve('/AppData');
      expect(r.kind).assertEqual('sandbox');
      expect(r.sandboxPath).assertEqual('/tmp/mditor-test');
      const r2 = m.resolve('/AppData/logs/memory.log');
      expect(r2.sandboxPath).assertEqual('/tmp/mditor-test/logs/memory.log');
    });

    it('resolve /Docs/<token>/<rel> 映射 URI（根与相对路径）', 0, () => {
      const m = new UriMapper('/tmp/mditor-test');
      m.mountRoot('file://docs/storage/Users/x/Docs/notes', 'notes');
      const root = m.resolve('/Docs/ws-1');
      expect(root.kind).assertEqual('uri');
      expect(root.uri).assertEqual('file://docs/storage/Users/x/Docs/notes');
      const file = m.resolve('/Docs/ws-1/sub/a.md');
      expect(file.uri).assertEqual('file://docs/storage/Users/x/Docs/notes/sub/a.md');
    });

    it('S7：拒绝 .. 穿越段（/Docs 与 /AppData 两分支），. 与空段被丢弃', 0, () => {
      const m = new UriMapper('/tmp/mditor-test');
      m.mountRoot('file://docs/storage/Users/x/Docs/notes', 'notes');
      // /Docs 分支：.. 越出工作区根 → 抛错
      let threw = false;
      try {
        m.resolve('/Docs/ws-1/../../etc/passwd');
      } catch (e) {
        threw = true;
      }
      expect(threw).assertTrue();
      // /AppData 分支：.. 越出沙箱 → 抛错
      let threw2 = false;
      try {
        m.resolve('/AppData/../secrets');
      } catch (e2) {
        threw2 = true;
      }
      expect(threw2).assertTrue();
      // `.` 与重复斜杠被消毒，正常解析不受影响
      const r = m.resolve('/Docs/ws-1/./sub//a.md');
      expect(r.uri).assertEqual('file://docs/storage/Users/x/Docs/notes/sub/a.md');
      const r2 = m.resolve('/AppData/./logs//memory.log');
      expect(r2.sandboxPath).assertEqual('/tmp/mditor-test/logs/memory.log');
    });

    it('中文与特殊字符文件名按段 encodeURIComponent', 0, () => {
      const m = new UriMapper('/tmp/mditor-test');
      m.mountRoot('file://docs/storage/Users/x/Docs/库', '库');
      const file = m.resolve('/Docs/ws-1/中文 目录/笔记 #1.md');
      const expected = 'file://docs/storage/Users/x/Docs/' +
        encodeURIComponent('库') + '/' + encodeURIComponent('中文 目录') + '/' +
        encodeURIComponent('笔记 #1.md');
      expect(file.uri).assertEqual(expected);
    });

    it('未知 token / 非法前缀抛错；tryResolve 返回 null', 0, () => {
      const m = new UriMapper('/tmp/mditor-test');
      let threw = false;
      try {
        m.resolve('/Docs/ws-99/a.md');
      } catch {
        threw = true;
      }
      expect(threw).assertTrue();
      threw = false;
      try {
        m.resolve('C:/whatever');
      } catch {
        threw = true;
      }
      expect(threw).assertTrue();
      expect(m.tryResolve('/Docs/ws-99/a.md')).assertNull();
      expect(m.tryResolve('/AppData/x') !== null).assertTrue();
    });
  });

  describe('AiBridge 纯函数', () => {
    it('parseStreamChunk：常规帧 content/reasoning/tool_calls/finish_reason', 0, () => {
      const info = parseStreamChunk(
        '{ "choices": [ { "delta": { "content": "你", "reasoning_content": "深思考", ' +
        '"reasoning": "浅思考", "tool_calls": [ { "index": 0 } ] }, "finish_reason": null } ] }');
      expect(info !== null).assertTrue();
      if (info === null) {
        return;
      }
      expect(info.content).assertEqual('你');
      // reasoning_content（DeepSeek-R1/GLM/Qwen3/Kimi）优先于 reasoning（OpenAI o 系）
      expect(info.reasoning).assertEqual('深思考');
      const tcs = info.toolCalls;
      expect(tcs !== null).assertTrue();
      if (tcs === null) {
        return;
      }
      expect(tcs.length).assertEqual(1);
      expect(info.finishReason).assertNull();
    });

    it('parseStreamChunk：仅 reasoning 字段时兜底 + finish_reason 透传', 0, () => {
      const info = parseStreamChunk(
        '{ "choices": [ { "delta": { "reasoning": "链" }, "finish_reason": "tool_calls" } ] }');
      expect(info !== null).assertTrue();
      if (info === null) {
        return;
      }
      expect(info.reasoning).assertEqual('链');
      expect(info.content).assertNull();
      expect(info.finishReason).assertEqual('tool_calls');
    });

    it('parseStreamChunk：[DONE]/非 JSON/无 choices/纯量 → null（调用方跳过）', 0, () => {
      expect(parseStreamChunk('[DONE]')).assertNull();
      expect(parseStreamChunk('oops not json')).assertNull();
      expect(parseStreamChunk('{}')).assertNull();
      expect(parseStreamChunk('[]')).assertNull();
      expect(parseStreamChunk('42')).assertNull();
      // role-only / keepalive 帧：全 null 但不是 null 本身
      const info = parseStreamChunk('{ "choices": [ { "delta": { } } ] }');
      expect(info !== null).assertTrue();
      if (info === null) {
        return;
      }
      expect(info.content).assertNull();
      expect(info.reasoning).assertNull();
      expect(info.toolCalls).assertNull();
      expect(info.finishReason).assertNull();
    });

    it('mergeToolCallDeltas：index 分组聚合、arguments 拼接、id/name 取首个非空', 0, () => {
      const agg: Map<number, AggToolCall> = new Map();
      const fnA: Record<string, Object> = { 'name': 'get_weather', 'arguments': '{"city":' };
      const fnB: Record<string, Object> = { 'arguments': '"北京"}' };
      const fnC: Record<string, Object> = { 'name': 'get_time', 'arguments': '{}' };
      const d0: Record<string, Object> = { 'index': 0, 'id': 'call_a', 'function': fnA };
      const d1: Record<string, Object> = { 'index': 1, 'id': 'call_b', 'function': fnC };
      const d0b: Record<string, Object> = { 'index': 0, 'id': 'call_z', 'function': fnB };
      const deltas: Array<Object> = [d0, d1, d0b];
      mergeToolCallDeltas(agg, deltas);
      expect(agg.size).assertEqual(2);
      const slot0 = agg.get(0);
      const slot1 = agg.get(1);
      expect(slot0 !== undefined).assertTrue();
      expect(slot1 !== undefined).assertTrue();
      if (slot0 === undefined || slot1 === undefined) {
        return;
      }
      expect(slot0.id).assertEqual('call_a'); // id 取首个非空（call_z 不覆盖）
      expect(slot0.name).assertEqual('get_weather');
      expect(slot0.arguments).assertEqual('{"city":"北京"}'); // 跨 delta 字符串拼接
      expect(slot1.name).assertEqual('get_time');
      expect(slot1.arguments).assertEqual('{}');
    });

    it('mergeToolCallDeltas + finalizeToolCalls：按 index 升序输出 OpenAI 形状', 0, () => {
      const agg: Map<number, AggToolCall> = new Map();
      const fn0: Record<string, Object> = { 'name': 'a', 'arguments': '{}' };
      const fn1: Record<string, Object> = { 'name': 'b', 'arguments': '"x"' };
      const d1: Record<string, Object> = { 'index': 1, 'id': 'call_b', 'function': fn1 };
      const d0: Record<string, Object> = { 'index': 0, 'id': 'call_a', 'function': fn0 };
      const arr: Array<Object> = [d1, d0]; // 乱序进入
      mergeToolCallDeltas(agg, arr);
      const out = finalizeToolCalls(agg);
      expect(out.length).assertEqual(2);
      expect(out[0]['id']).assertEqual('call_a'); // 升序：index 0 在前
      expect(out[0]['type']).assertEqual('function');
      const fn = out[0]['function'] as Record<string, Object>;
      expect(fn['name']).assertEqual('a');
      expect(out[1]['id']).assertEqual('call_b');
      const fnOut1 = out[1]['function'] as Record<string, Object>;
      expect(fnOut1['arguments']).assertEqual('"x"');
    });

    it('mergeToolCallDeltas：delta 无 index 时用数组下标兜底', 0, () => {
      const agg: Map<number, AggToolCall> = new Map();
      const fn: Record<string, Object> = { 'name': 'x', 'arguments': '1' };
      const noIdx: Record<string, Object> = { 'function': fn };
      const arr: Array<Object> = [noIdx]; // 位置 0 → key 0
      mergeToolCallDeltas(agg, arr);
      const slot = agg.get(0);
      expect(slot !== undefined).assertTrue();
      if (slot === undefined) {
        return;
      }
      expect(slot.name).assertEqual('x');
      expect(slot.arguments).assertEqual('1');
    });
  });

  describe('S3Bridge 纯函数', () => {
    it('validateKeyError：空/..段/反斜杠/前导斜杠/超长 → SYNC-006；合法中文 key → null', 0, () => {
      expect(validateKeyError('')).assertEqual('SYNC-006: 对象 key 不能为空');
      expect(validateKeyError('a/../b.md')).assertEqual('SYNC-006: 对象 key 不能包含 .. 路径段');
      expect(validateKeyError('a\\b.md')).assertEqual('SYNC-006: 对象 key 不能包含反斜杠');
      expect(validateKeyError('/top.md')).assertEqual('SYNC-006: 对象 key 不能以 / 开头');
      expect(validateKeyError('a'.repeat(1025)) !== null).assertTrue();
      expect(validateKeyError('笔记/子目录/文档 #1.md')).assertNull();
    });

    it('mapStatusError：401/403→SYNC-001、404→SYNC-002、AccessDenied→SYNC-001、其余→SYNC-999', 0, () => {
      expect(mapStatusError('测试', 403, '', '').message.startsWith('SYNC-001')).assertTrue();
      expect(mapStatusError('测试', 401, '', '').message.startsWith('SYNC-001')).assertTrue();
      expect(mapStatusError('测试', 404, '', '').message.startsWith('SYNC-002')).assertTrue();
      expect(mapStatusError('测试', 400, 'AccessDenied', '').message.startsWith('SYNC-001')).assertTrue();
      expect(mapStatusError('测试', 404, 'NoSuchKey', '').message.startsWith('SYNC-002')).assertTrue();
      expect(mapStatusError('测试', 500, '', 'oops').message.startsWith('SYNC-999')).assertTrue();
      const e = mapStatusError('测试', 403, '', '');
      expect(e.code).assertEqual('E_IO');
    });

    // parseListXml 依赖 util.TextEncoder（@kit.ArkTS）做 UTF-8 转字节，hypium
    // 本地宿主对 kit API 是无实现 stub（encodeInto 返回空 → 解析 0 条，实锤
    // 见 task-W8 记录），故该用例只能在 DevEco 真机/模拟器 OnDevice Test 跑。
    // 这里改测其两个纯字符串子件（xmlDecode / stripEtagQuotes 均顶层导出）。
    it('xmlDecode + stripEtagQuotes：S3 XML 实体还原与裸 etag', 0, () => {
      expect(xmlDecode('&quot;a&amp;b&quot;')).assertEqual('"a&b"');
      expect(xmlDecode('&lt;x&gt; &apos;y&apos;')).assertEqual('<x> \'y\'');
      expect(stripEtagQuotes('"abc123"')).assertEqual('abc123');
      expect(stripEtagQuotes('"abc')).assertEqual('abc'); // 只有一侧引号也剥
      expect(stripEtagQuotes('plain')).assertEqual('plain');
      expect(stripEtagQuotes(null)).assertNull();
    });
  });
}
