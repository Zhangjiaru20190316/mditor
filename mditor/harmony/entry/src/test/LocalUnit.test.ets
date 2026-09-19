// UriMapper 本地单测（hypium）——纯逻辑锚定：token 分配/幂等挂载、
// 虚拟路径解析（/AppData、/Docs/<token>/<rel>，含中文与特殊字符编码）、
// 未知 token 报错、tryResolve 软失败。
//
// 本地测试环境无真实沙箱：UriMapper 的 load/persist 均 fail-soft（fs 异常
// 被吞、内存映射照常工作），因此逻辑路径可完全离线验证。

import { describe, it, expect } from '@ohos/hypium';
import { UriMapper } from '../main/ets/io/UriMapper';

export default function UriMapperTest() {
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
}
