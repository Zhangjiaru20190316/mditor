// S3Bridge.ets —— S3 协议兼容对象存储六命令的桥实现（v4.13 P3：ArkTS SigV4）。
//
// 桌面契约移植自 src-tauri/src/s3.rs（method 名与参数键 camelCase 逐字一致，
// 前端 src/lib/sync/s3.ts 是唯一调用方；扫描/清单/3-way 合并全在前端）：
//   s3_test_connection {cfg}                → {bucket, endpoint, region}
//   s3_list           {cfg, prefix}         → S3Object[]（≤10000 键）
//   s3_get            {cfg, key}            → {base64}（桌面为二进制 IPC，
//                                             前端适配层按运行时解码——D4）
//   s3_put            {cfg, key, data(base64), mtimeMs?} → S3Object（PUT 后
//                                             HEAD 取回规范元数据）
//   s3_delete         {cfg, key}            → null
//   s3_head           {cfg, key}            → S3Object | null（404 → null）
//   cfg = {endpoint, region, bucket, accessKeyId, secretAccessKey,
//          sessionToken?, pathStyle}
//   S3Object = {key, size, etag(无引号), lastModified(RFC3339/ISO)}
//
// 硬约束（全量复刻 s3.rs）：
//   * 错误消息「SYNC-XXX: 中文消息」——001 凭证 / 002 桶 / 003 网络 /
//     004 超时 / 005 超限 / 006 非法 key / 999 未知（parseSyncError 依赖）
//   * validate_key：拒 `..` 段/反斜杠/控制字符/前导 `/`，≤1024 字节
//   * 单对象 ≤50MB；List ≤10000 键；连接 10s / 读 30s 超时
//   * 仅 HTTPS；localhost/127.0.0.1 放行 HTTP（MinIO 本地调试）
//   * 错误消息绝不含 Authorization/密钥/签名串（D5）
//
// SigV4 手写（cryptoFramework：createMd('SHA256') 算 payload hash、
// createMac('SHA256') 做签名链）；URI 编码 RFC3986（unreserved 之外全编码，
// 路径段保留 /，query 键值全编码）；ListObjectsV2 用 XmlPullParser 聚焦
// 解析（只认 Key/Size/ETag/LastModified/IsTruncated/NextContinuationToken）。
// 中间值（canonical request / string-to-sign，不含任何密钥材料）可经
// SIGV4_DEBUG 开关输出到 hilog，供 AWS 官方测试向量比对；默认关闭。
//
// 签名纯函数与 scripts/sigv4-check.mjs 逐行镜像（Node 侧对 AWS 测试套件
// 向量核验）；hypium 无本地宿主，纯函数即核验底线（D6）。

import { http } from '@kit.NetworkKit';
import { util, url as urlKit, xml } from '@kit.ArkTS';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { Bridge, BridgeError } from '../bridge/Bridge';

const DOMAIN = 0x0D01;

/** 单对象字节上限（对齐 s3.rs MAX_OBJECT_BYTES：50MB）。 */
const MAX_OBJECT_BYTES = 50 * 1024 * 1024;
/** 单次 List 累计键上限（对齐 MAX_LIST_KEYS）。 */
const MAX_LIST_KEYS = 10000;
/** ListObjectsV2 分页大小（AWS 单页上限）。 */
const PAGE_KEYS = 1000;
const CONNECT_TIMEOUT_MS = 10000;
const READ_TIMEOUT_MS = 30000;
/** 空载荷 SHA256（SigV4 常量 e3b0c4…855）。 */
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
/** SigV4 调试开关：输出 canonical request / string-to-sign（不含密钥）。 */
const SIGV4_DEBUG = false;

// ---- 纯函数区（与 scripts/sigv4-check.mjs 镜像，可向量核验） ------------------

/** 键值对（canonical query / 签名头统一形状；ArkTS 禁内联对象字面量类型）。 */
interface StrPair {
  k: string;
  v: string;
}


/** RFC3986 编码：unreserved（A-Za-z0-9-._~）之外全编码；keepSlash 保留 /。 */
export function uriEncode(s: string, keepSlash: boolean): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    // 代理对按完整码点编码（encodeURIComponent 对孤立代理会产生 CESU-8 错误字节）
    let ch = s[i];
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
      const c2 = s.charCodeAt(i + 1);
      if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
        ch = s.substr(i, 2);
        i += 1;
      }
    }
    const unreserved = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
      (c >= 48 && c <= 57) || c === 45 || c === 46 || c === 95 || c === 126;
    if (unreserved) {
      out += ch;
    } else if (c === 47 && keepSlash) {
      out += '/';
    } else {
      // encodeURIComponent 产出正确的 UTF-8 百分号编码，但漏 !'()* 四个字符
      const enc = encodeURIComponent(ch);
      for (let j = 0; j < enc.length; j++) {
        const ec = enc[j];
        if (ec === '!' || ec === '\'' || ec === '(' || ec === ')' || ec === '*') {
          out += `%${ec.charCodeAt(0).toString(16).toUpperCase()}`;
        } else {
          out += ec;
        }
      }
    }
    i += 1;
  }
  return out;
}

/** 对象 key → 规范路径段（逐段编码，保留 / 分隔）。 */
export function uriEncodePath(p: string): string {
  const segs = p.split('/');
  const out: string[] = [];
  for (const seg of segs) {
    out.push(uriEncode(seg, true));
  }
  return out.join('/');
}

/** ISO8601 基本 amzDate（YYYYMMDD'T'HHMMSS'Z'）。 */
export function amzDateOf(d: Date): string {
  const p2 = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}` +
    `T${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`;
}

/** key 合法性校验（对齐 validate_key）；返回错误消息或 null。 */
export function validateKeyError(key: string): string | null {
  if (key.length === 0) {
    return 'SYNC-006: 对象 key 不能为空';
  }
  if (key.length > 1024) {
    return 'SYNC-006: 对象 key 过长（>1024 字节）';
  }
  if (key.startsWith('/')) {
    return 'SYNC-006: 对象 key 不能以 / 开头';
  }
  if (key.includes('\\')) {
    return 'SYNC-006: 对象 key 不能包含反斜杠';
  }
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    if (c < 0x20 || c === 0x7F) {
      return 'SYNC-006: 对象 key 不能包含控制字符';
    }
  }
  const segs = key.split('/');
  for (const seg of segs) {
    if (seg === '..') {
      return 'SYNC-006: 对象 key 不能包含 .. 路径段';
    }
  }
  return null;
}

/** 明文 HTTP 放行：仅 localhost / 127.0.0.1（对齐 http_endpoint_allowed）。 */
export function httpEndpointAllowed(endpoint: string): boolean {
  const lower = endpoint.trimStart().toLowerCase();
  if (!lower.startsWith('http://')) {
    return false;
  }
  const rest = lower.slice('http://'.length);
  const host = rest.split(/[:/]/)[0] ?? '';
  return host === 'localhost' || host === '127.0.0.1';
}

/** 规范查询串：键值全编码、按编码后键排序，产出 'k=v&k=v'。 */
export function canonicalQueryOf(pairs: Array<StrPair>): string {
  const encoded: Array<StrPair> = [];
  for (const p of pairs) {
    encoded.push({ k: uriEncode(p.k, false), v: uriEncode(p.v, false) });
  }
  encoded.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  const parts: string[] = [];
  for (const p of encoded) {
    parts.push(`${p.k}=${p.v}`);
  }
  return parts.join('&');
}

/** 规范请求（SigV4 第 1 步）。headers 需小写键、值 trim。 */
export function canonicalRequestOf(method: string, canonicalPath: string,
  canonicalQuery: string, headers: Array<StrPair>, payloadHash: string): string {
  const sorted = headers.slice();
  sorted.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  let headerLines = '';
  const names: string[] = [];
  for (const h of sorted) {
    headerLines += `${h.k}:${h.v.trim()}\n`;
    names.push(h.k);
  }
  return `${method}\n${canonicalPath}\n${canonicalQuery}\n${headerLines}\n${names.join(';')}\n${payloadHash}`;
}

// ---- 哈希/签名原语（Node 侧核验时用 WebCrypto 同语义） ------------------------

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const h = (bytes[i] & 0xFF).toString(16);
    out += h.length === 1 ? `0${h}` : h;
  }
  return out;
}

function utf8Bytes(s: string): Uint8Array {
  const encoder = util.TextEncoder.create('utf-8');
  return encoder.encodeInto(s);
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const md = cryptoFramework.createMd('SHA256');
  const blob: cryptoFramework.DataBlob = { data: data };
  await md.update(blob);
  const out = await md.digest();
  return bytesToHex(out.data);
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const mac = cryptoFramework.createMac('SHA256');
  const keyGen = cryptoFramework.createSymKeyGenerator('SHA256');
  const keyBlob: cryptoFramework.DataBlob = { data: key };
  const symKey = await keyGen.convertKey(keyBlob);
  await mac.init(symKey);
  const dataBlob: cryptoFramework.DataBlob = { data: data };
  await mac.update(dataBlob);
  const out = await mac.doFinal();
  return out.data;
}

// ---- 配置与目标 URL ----------------------------------------------------------

/** 前端 cfg 载荷（camelCase）。 */
class S3Config {
  endpoint: string = '';
  region: string = '';
  bucket: string = '';
  accessKeyId: string = '';
  secretAccessKey: string = '';
  sessionToken: string = '';
  pathStyle: boolean = false;
}

function asRecord(v: Object | undefined): Record<string, Object> | null {
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    return v as Record<string, Object>;
  }
  return null;
}

function strOf(v: Object | undefined): string | null {
  return typeof v === 'string' ? v as string : null;
}

function boolOf(v: Object | undefined): boolean {
  return v === true;
}

function parseCfg(v: Object | undefined): S3Config {
  const rec = asRecord(v);
  const cfg = new S3Config();
  if (rec === null) {
    throw new BridgeError('E_ARGS', '参数缺失或类型错误：cfg');
  }
  cfg.endpoint = strOf(rec['endpoint']) ?? '';
  cfg.region = strOf(rec['region']) ?? '';
  cfg.bucket = strOf(rec['bucket']) ?? '';
  cfg.accessKeyId = strOf(rec['accessKeyId']) ?? '';
  cfg.secretAccessKey = strOf(rec['secretAccessKey']) ?? '';
  const token = strOf(rec['sessionToken']);
  cfg.sessionToken = token !== null ? token : '';
  cfg.pathStyle = boolOf(rec['pathStyle']);
  if (cfg.bucket.trim().length === 0) {
    throw new BridgeError('E_ARGS', '参数缺失或类型错误：cfg.bucket');
  }
  return cfg;
}

/** 解析后的 endpoint（endpoint 为空 = AWS 默认端点）。 */
class EndpointParts {
  scheme: string = 'https';
  host: string = '';
  port: number = 443;
  basePath: string = '';
}

function parseEndpoint(endpoint: string): EndpointParts {
  const parts = new EndpointParts();
  const trimmed = endpoint.trim();
  if (trimmed.length === 0) {
    return parts; // AWS 默认（vhost 由调用方按 bucket 构造）
  }
  let u: urlKit.URL;
  try {
    u = new urlKit.URL(trimmed);
  } catch {
    throw new BridgeError('E_IO', 'SYNC-999: endpoint 无法解析（应类似 https://s3.example.com 或留空使用 AWS 默认端点）');
  }
  // @ohos.url.URL 形状：protocol 带尾冒号；host 含非默认端口、hostname 不含；
  // port 在默认端口（https 443 / http 80）时为空串。
  parts.scheme = (u.protocol ?? 'https:').replace(/:$/, '');
  const host = u.hostname ?? '';
  if (host.length === 0) {
    throw new BridgeError('E_IO', 'SYNC-999: endpoint 缺少主机名');
  }
  parts.host = host;
  const portStr = u.port ?? '';
  parts.port = portStr.length > 0 ? parseInt(portStr) :
    (parts.scheme === 'http' ? 80 : 443);
  const path = u.pathname ?? '';
  parts.basePath = path.replace(/\/+$/, '');
  return parts;
}

/** 请求目标：完整 URL + 签名用规范路径/查询。 */
class ReqTarget {
  url: string = '';
  canonicalPath: string = '';
  canonicalQuery: string = '';
  hostHeader: string = '';
}

/**
 * 构造对象请求目标。寻址三种形态（对齐 object_store）：
 *   endpoint 空 + pathStyle=false → https://{bucket}.s3.{region}.amazonaws.com/{key}
 *   endpoint 空 + pathStyle=true  → https://s3.{region}.amazonaws.com/{bucket}/{key}
 *   endpoint 显式：pathStyle → {scheme}://{host:port}{base}/{bucket}/{key}
 *                 vhost     → {scheme}://{bucket}.{host:port}{base}/{key}
 * objectPath 为空 = 桶级操作（List）。
 */
export function buildTarget(cfg: S3Config, ep: EndpointParts, objectPath: string,
  queryPairs: Array<StrPair>): ReqTarget {
  const t = new ReqTarget();
  const encKey = uriEncodePath(objectPath);
  let scheme: string = ep.scheme;
  let host: string = ep.host;
  let port: number = ep.port;
  let path: string;
  if (ep.host.length === 0) {
    // AWS 默认端点（endpoint 为空；仅 HTTPS）
    scheme = 'https';
    port = 443;
    if (cfg.pathStyle) {
      host = `s3.${cfg.region}.amazonaws.com`;
      path = `/${uriEncode(cfg.bucket, true)}${objectPath.length > 0 ? `/${encKey}` : ''}`;
    } else {
      host = `${cfg.bucket}.s3.${cfg.region}.amazonaws.com`;
      path = objectPath.length > 0 ? `/${encKey}` : '/';
    }
  } else if (cfg.pathStyle) {
    path = `${ep.basePath}/${uriEncode(cfg.bucket, true)}${objectPath.length > 0 ? `/${encKey}` : ''}`;
  } else {
    host = `${cfg.bucket}.${ep.host}`;
    path = objectPath.length > 0 ? `${ep.basePath}/${encKey}` : (ep.basePath.length > 0 ? ep.basePath : '/');
  }
  const nonDefault = (scheme === 'https' && port !== 443) || (scheme === 'http' && port !== 80);
  const hostPort = nonDefault ? `${host}:${port}` : host;
  t.hostHeader = hostPort;
  t.canonicalPath = path;
  t.canonicalQuery = canonicalQueryOf(queryPairs);
  let url = `${scheme}://${hostPort}${path}`;
  if (t.canonicalQuery.length > 0) {
    url += `?${t.canonicalQuery}`;
  }
  t.url = url;
  return t;
}

// ---- 签名 -------------------------------------------------------------------

/** 产出带签名的请求头（Authorization + x-amz-*）。 */
async function signHeaders(cfg: S3Config, method: string, target: ReqTarget,
  payload: Uint8Array | null, extraAmz: Record<string, string>): Promise<Record<string, Object>> {
  const amzDate = amzDateOf(new Date());
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(payload ?? new Uint8Array(0));
  const headers: Array<StrPair> = [
    { k: 'host', v: target.hostHeader },
    { k: 'x-amz-content-sha256', v: payloadHash },
    { k: 'x-amz-date', v: amzDate },
  ];
  const extraKeys = Object.keys(extraAmz);
  for (const k of extraKeys) {
    headers.push({ k: k, v: extraAmz[k] }); // 仅 x-amz-*（已小写）
  }
  const canonical = canonicalRequestOf(method, target.canonicalPath, target.canonicalQuery,
    headers, payloadHash);
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const hashedCanonical = await sha256Hex(utf8Bytes(canonical));
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hashedCanonical}`;
  const kDate = await hmacSha256(utf8Bytes(`AWS4${cfg.secretAccessKey}`), utf8Bytes(dateStamp));
  const kRegion = await hmacSha256(kDate, utf8Bytes(cfg.region));
  const kService = await hmacSha256(kRegion, utf8Bytes('s3'));
  const kSigning = await hmacSha256(kService, utf8Bytes('aws4_request'));
  const signature = bytesToHex(await hmacSha256(kSigning, utf8Bytes(stringToSign)));
  if (SIGV4_DEBUG) {
    // 中间值比对 AWS 官方测试向量用；不含任何密钥材料（D5）。
    hilog.info(DOMAIN, 'mditor', 'SigV4 canonical: %{public}s', canonical);
    hilog.info(DOMAIN, 'mditor', 'SigV4 toSign: %{public}s', stringToSign);
    hilog.info(DOMAIN, 'mditor', 'SigV4 signature: %{public}s', signature);
  }
  const names: string[] = [];
  for (const h of headers) {
    names.push(h.k);
  }
  names.sort();
  const auth = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, ` +
    `SignedHeaders=${names.join(';')}, Signature=${signature}`;
  const out: Record<string, Object> = {
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    'Authorization': auth,
  };
  for (const k of extraKeys) {
    out[k] = extraAmz[k];
  }
  return out;
}

// ---- HTTP 执行与错误映射 ------------------------------------------------------

class S3Resp {
  code: number = 0;
  headers: Record<string, string> = {};
  bodyText: string = '';
  bodyBytes: Uint8Array | null = null;
}

/** 网络/系统错误 → SYNC-003/004（对齐 map_store_error 的 Generic 归类）。 */
function mapTransportError(ctx: string, err: BusinessError): BridgeError {
  const msg = err.message !== undefined ? err.message : String(err.code);
  if (msg.includes('timeout') || msg.includes('timed out') || err.code === 2300028) {
    return new BridgeError('E_IO', `SYNC-004: ${ctx}：请求超时（30s）`);
  }
  if (err.code === 2300006 || msg.includes('resolve') || msg.includes('connect') ||
    msg.includes('connection')) {
    return new BridgeError('E_IO', `SYNC-003: ${ctx}：网络不可达或连接被拒`);
  }
  return new BridgeError('E_IO', `SYNC-999: ${ctx}：${msg.slice(0, 160)}`);
}

/** 响应体里的 <Code> 提取（S3 XML 错误；无则空串）。 */
export function s3ErrorCodeOf(body: string): string {
  const m = /<Code>([^<]*)<\/Code>/.exec(body);
  return m !== null ? m[1] : '';
}

/** HTTP 状态 + S3 错误码 → SYNC-XXX（消息格式对齐 s3.rs map_store_error）。 */
export function mapStatusError(ctx: string, status: number, s3code: string, body: string): BridgeError {
  if (status === 401 || status === 403 || s3code === 'InvalidAccessKeyId' ||
    s3code === 'SignatureDoesNotMatch' || s3code === 'InvalidToken') {
    return new BridgeError('E_IO', `SYNC-001: ${ctx}：凭证无效或已过期（检查 AccessKey / SecretKey / STS 令牌）`);
  }
  if (s3code === 'AccessDenied') {
    return new BridgeError('E_IO', `SYNC-001: ${ctx}：访问被拒绝（凭证无该操作权限，建议最小权限子账号）`);
  }
  if (status === 404 || s3code === 'NoSuchBucket' || s3code === 'NoSuchKey') {
    return new BridgeError('E_IO', `SYNC-002: ${ctx}：桶不存在或无访问权限`);
  }
  const clip = body.slice(0, 160);
  return new BridgeError('E_IO', `SYNC-999: ${ctx}：HTTP ${status}${s3code.length > 0 ? ` ${s3code}` : ''} ${clip}`.trim());
}

function headerOf(headers: Record<string, string>, name: string): string | null {
  const lower = name.toLowerCase();
  const keys = Object.keys(headers);
  for (const k of keys) {
    if (k.toLowerCase() === lower) {
      return headers[k];
    }
  }
  return null;
}

/** etag 去引号（engine 的 isContentEtag 期望裸 32-hex）。 */
export function stripEtagQuotes(etag: string | null): string | null {
  if (etag === null) {
    return null;
  }
  let e = etag.trim();
  if (e.startsWith('"')) {
    e = e.slice(1);
  }
  if (e.endsWith('"')) {
    e = e.slice(0, e.length - 1);
  }
  return e;
}

/** RFC1123（HEAD 的 Last-Modified）/ ISO 字符串 → ISO（与 XML 路径同格式）。 */
export function toIsoTime(v: string | null): string | null {
  if (v === null) {
    return null;
  }
  const t = Date.parse(v);
  if (Number.isNaN(t)) {
    return null;
  }
  return new Date(t).toISOString();
}

async function doRequest(target: ReqTarget, headers: Record<string, Object>,
  method: http.RequestMethod, body: Uint8Array | null, wantBytes: boolean,
  ctx: string): Promise<S3Resp> {
  const client = http.createHttp();
  try {
    const options: http.HttpRequestOptions = {
      method: method,
      header: headers,
      connectTimeout: CONNECT_TIMEOUT_MS,
      readTimeout: READ_TIMEOUT_MS,
      usingCache: false,
      expectDataType: wantBytes ? http.HttpDataType.ARRAY_BUFFER : http.HttpDataType.STRING,
    };
    if (body !== null) {
      // extraData 只接受 ArrayBuffer（Uint8Array 会被误当 Object 序列化）。
      options.extraData = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    }
    const resp = await client.request(target.url, options);
    const out = new S3Resp();
    out.code = resp.responseCode;
    const hdr = resp.header as Record<string, string>;
    out.headers = hdr === undefined || hdr === null ? {} : hdr;
    if (wantBytes && resp.result instanceof ArrayBuffer) {
      out.bodyBytes = new Uint8Array(resp.result);
    } else if (!wantBytes && typeof resp.result === 'string') {
      out.bodyText = resp.result as string;
    }
    return out;
  } catch (err) {
    if (err instanceof BridgeError) {
      throw err;
    }
    throw mapTransportError(ctx, err as BusinessError);
  } finally {
    try {
      client.destroy();
    } catch {
      // 已销毁 — 忽略
    }
  }
}

/** 校验 endpoint 传输约束（HTTPS；HTTP 仅 localhost）。 */
function ensureScheme(ep: EndpointParts, endpoint: string): void {
  if (ep.scheme !== 'https' && ep.scheme !== 'http') {
    throw new BridgeError('E_IO', `SYNC-003: 仅允许 HTTPS endpoint（HTTP 仅限 localhost/127.0.0.1 本地调试）`);
  }
  if (ep.scheme === 'http' && !httpEndpointAllowed(endpoint)) {
    throw new BridgeError('E_IO', `SYNC-003: 仅允许 HTTPS endpoint（HTTP 仅限 localhost/127.0.0.1 本地调试）`);
  }
}

// ---- ListObjectsV2 XML 解析（聚焦） ------------------------------------------

class ListParseResult {
  objects: Array<Record<string, Object>> = [];
  truncated: boolean = false;
  nextToken: string | null = null;
}

/** XML 实体还原（部分解析器不展开非标准实体）。 */
export function xmlDecode(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, '\'');
}

/**
 * ListBucketResult 聚焦解析：只认 Key/Size/ETag/LastModified/IsTruncated/
 * NextContinuationToken。key 因 encoding-type=url 需 percent-decode。
 * 事件级回调 tokenValueCallbackFunction（API 22 形状）。
 */
export function parseListXml(xmlText: string): ListParseResult {
  const res = new ListParseResult();
  let inContents = false;
  let curTag = '';
  let curKey = '';
  let curSize = '';
  let curEtag = '';
  let curLm = '';
  const bytes = utf8Bytes(xmlText);
  const parser = new xml.XmlPullParser(bytes.buffer as ArrayBuffer, 'utf-8');
  const options: xml.ParseOptions = {
    supportDoctype: false,
    ignoreNameSpace: false,
    tokenValueCallbackFunction: (eventType: xml.EventType, info: xml.ParseInfo): boolean => {
      const tag = info.getName() ?? '';
      switch (eventType) {
        case xml.EventType.START_TAG:
          if (tag === 'Contents') {
            inContents = true;
            curKey = '';
            curSize = '';
            curEtag = '';
            curLm = '';
          }
          curTag = tag;
          break;
        case xml.EventType.TEXT: {
          const text = info.getText() ?? '';
          if (text.length === 0) {
            break;
          }
          if (!inContents) {
            if (curTag === 'IsTruncated' && text.trim() === 'true') {
              res.truncated = true;
            } else if (curTag === 'NextContinuationToken') {
              res.nextToken = (res.nextToken ?? '') + text;
            }
          } else if (curTag === 'Key') {
            curKey += text;
          } else if (curTag === 'Size') {
            curSize += text;
          } else if (curTag === 'ETag') {
            curEtag += text;
          } else if (curTag === 'LastModified') {
            curLm += text;
          }
          break;
        }
        case xml.EventType.END_TAG:
          if (tag === 'Contents' && inContents) {
            let key = xmlDecode(curKey);
            try {
              key = decodeURIComponent(key);
            } catch {
              // 已是明文 — 保持
            }
            const size = parseInt(curSize.trim(), 10);
            const obj: Record<string, Object> = {
              'key': key,
              'size': Number.isNaN(size) ? 0 : size,
              'etag': stripEtagQuotes(xmlDecode(curEtag)) ?? '',
              'lastModified': xmlDecode(curLm.trim()),
            };
            res.objects.push(obj);
            inContents = false;
          }
          curTag = '';
          break;
        default:
          break;
      }
      return true; // 继续解析
    },
  };
  parser.parse(options);
  return res;
}

// ---- 桥实现 -------------------------------------------------------------------

/** S3Object 出参（camelCase 对齐前端类型）。 */
function s3ObjectOf(key: string, size: number, etag: string | null, lastModified: string | null): Record<string, Object> {
  return {
    'key': key,
    'size': size,
    'etag': etag ?? '',
    'lastModified': lastModified ?? new Date(0).toISOString(),
  };
}

export class S3Bridge {
  private readonly bridge: Bridge;

  constructor(bridge: Bridge) {
    this.bridge = bridge;
  }

  registerAll(): void {
    this.bridge.register('s3_test_connection', (p) => this.testConnection(p));
    this.bridge.register('s3_list', (p) => this.list(p));
    this.bridge.register('s3_get', (p) => this.get(p));
    this.bridge.register('s3_put', (p) => this.put(p));
    this.bridge.register('s3_delete', (p) => this.delete(p));
    this.bridge.register('s3_head', (p) => this.head(p));
    hilog.info(DOMAIN, 'mditor', 'S3Bridge: 六命令已注册');
  }

  /** 连通性测试：List 1 键（验证 endpoint + 凭证 + 桶存在 + ListBucket 权限）。 */
  async testConnection(params: Record<string, Object>): Promise<Object | null> {
    const cfg = parseCfg(params['cfg']);
    const ep = parseEndpoint(cfg.endpoint);
    ensureScheme(ep, cfg.endpoint);
    const pairs: Array<StrPair> = [
      { k: 'list-type', v: '2' },
      { k: 'max-keys', v: '1' },
      { k: 'encoding-type', v: 'url' },
    ];
    const target = buildTarget(cfg, ep, '', pairs);
    const headers = await this.signedHeadersFor(cfg, 'GET', target, null, this.tokenExtra(cfg));
    const resp = await doRequest(target, headers, http.RequestMethod.GET, null, false, '测试连接失败');
    if (resp.code >= 400) {
      throw mapStatusError('测试连接失败', resp.code, s3ErrorCodeOf(resp.bodyText), resp.bodyText);
    }
    const out: Record<string, Object> = {
      'bucket': cfg.bucket,
      'endpoint': cfg.endpoint,
      'region': cfg.region,
    };
    return out;
  }

  /** ListObjectsV2 全分页累计（上限 10000 键）。 */
  async list(params: Record<string, Object>): Promise<Object | null> {
    const cfg = parseCfg(params['cfg']);
    const ep = parseEndpoint(cfg.endpoint);
    ensureScheme(ep, cfg.endpoint);
    const prefix = strOf(params['prefix']) ?? '';
    const out: Array<Record<string, Object>> = [];
    let token: string | null = null;
    for (;;) {
      const pairs: Array<StrPair> = [
        { k: 'list-type', v: '2' },
        { k: 'max-keys', v: `${PAGE_KEYS}` },
        { k: 'encoding-type', v: 'url' },
      ];
      if (prefix.length > 0) {
        pairs.push({ k: 'prefix', v: prefix });
      }
      if (token !== null && token.length > 0) {
        pairs.push({ k: 'continuation-token', v: token });
      }
      const target = buildTarget(cfg, ep, '', pairs);
      const headers = await this.signedHeadersFor(cfg, 'GET', target, null, this.tokenExtra(cfg));
      const resp = await doRequest(target, headers, http.RequestMethod.GET, null, false, '列举对象失败');
      if (resp.code >= 400) {
        throw mapStatusError('列举对象失败', resp.code, s3ErrorCodeOf(resp.bodyText), resp.bodyText);
      }
      const page = parseListXml(resp.bodyText);
      for (const obj of page.objects) {
        out.push(obj);
      }
      if (!page.truncated || page.nextToken === null || out.length >= MAX_LIST_KEYS) {
        break;
      }
      token = page.nextToken;
    }
    return out;
  }

  /** 下载对象：HEAD（存在性 + ≤50MB）→ GET → {base64}。 */
  async get(params: Record<string, Object>): Promise<Object | null> {
    const key = this.keyOf(params);
    const cfg = parseCfg(params['cfg']);
    const ep = parseEndpoint(cfg.endpoint);
    ensureScheme(ep, cfg.endpoint);
    // HEAD 阶段：404 → 002（对象不存在或无权限）
    const headTarget = buildTarget(cfg, ep, key, []);
    const headHeaders = await this.signedHeadersFor(cfg, 'HEAD', headTarget, null, this.tokenExtra(cfg));
    const headResp = await doRequest(headTarget, headHeaders, http.RequestMethod.HEAD, null, false,
      '下载失败（对象不存在或无权限）');
    if (headResp.code === 404) {
      throw mapStatusError('下载失败（对象不存在或无权限）', 404, '', '');
    }
    if (headResp.code >= 400) {
      throw mapStatusError('下载失败（对象不存在或无权限）', headResp.code,
        s3ErrorCodeOf(headResp.bodyText), headResp.bodyText);
    }
    const sizeHeader = headerOf(headResp.headers, 'content-length');
    const declared = sizeHeader !== null ? parseInt(sizeHeader, 10) : 0;
    if (declared > MAX_OBJECT_BYTES) {
      throw new BridgeError('E_IO', `SYNC-005: 对象过大（${declared} 字节，上限 ${MAX_OBJECT_BYTES}）`);
    }
    const target = buildTarget(cfg, ep, key, []);
    const headers = await this.signedHeadersFor(cfg, 'GET', target, null, this.tokenExtra(cfg));
    const resp = await doRequest(target, headers, http.RequestMethod.GET, null, true, '下载失败');
    if (resp.code >= 400) {
      throw mapStatusError('下载失败', resp.code, s3ErrorCodeOf(resp.bodyText), '');
    }
    const bytes = resp.bodyBytes ?? new Uint8Array(0);
    if (bytes.length > MAX_OBJECT_BYTES) {
      throw new BridgeError('E_IO', `SYNC-005: 对象过大（${bytes.length} 字节，上限 ${MAX_OBJECT_BYTES}）`);
    }
    const b64 = new util.Base64Helper().encodeToStringSync(bytes);
    const out: Record<string, Object> = { 'base64': b64 };
    return out;
  }

  /** 上传：base64 解码（≤50MB）→ PUT（尽力 x-amz-meta-mtime）→ HEAD 取回。 */
  async put(params: Record<string, Object>): Promise<Object | null> {
    const key = this.keyOf(params);
    const cfg = parseCfg(params['cfg']);
    const ep = parseEndpoint(cfg.endpoint);
    ensureScheme(ep, cfg.endpoint);
    const dataB64 = strOf(params['data']) ?? '';
    const bytes = new util.Base64Helper().decodeSync(dataB64);
    if (bytes.length > MAX_OBJECT_BYTES) {
      throw new BridgeError('E_IO', `SYNC-005: 文件过大（${bytes.length} 字节，上限 ${MAX_OBJECT_BYTES}）`);
    }
    const extra: Record<string, string> = {};
    const mtimeMs = params['mtimeMs'];
    if (typeof mtimeMs === 'number' && isFinite(mtimeMs as number) && (mtimeMs as number) >= 0) {
      extra['x-amz-meta-mtime'] = `${Math.round(mtimeMs as number)}`;
    }
    if (cfg.sessionToken.length > 0) {
      extra['x-amz-security-token'] = cfg.sessionToken;
    }
    const target = buildTarget(cfg, ep, key, []);
    const headers = await this.signedHeadersFor(cfg, 'PUT', target, bytes, extra);
    const resp = await doRequest(target, headers, http.RequestMethod.PUT, bytes, false, '上传失败');
    if (resp.code >= 400) {
      throw mapStatusError('上传失败', resp.code, s3ErrorCodeOf(resp.bodyText), resp.bodyText);
    }
    return await this.headObject(cfg, ep, key, '上传后校验失败');
  }

  /** 删除远端对象（幂等：404 视为成功）。 */
  async delete(params: Record<string, Object>): Promise<Object | null> {
    const key = this.keyOf(params);
    const cfg = parseCfg(params['cfg']);
    const ep = parseEndpoint(cfg.endpoint);
    ensureScheme(ep, cfg.endpoint);
    const extra = this.tokenExtra(cfg);
    const target = buildTarget(cfg, ep, key, []);
    const headers = await this.signedHeadersFor(cfg, 'DELETE', target, null, extra);
    const resp = await doRequest(target, headers, http.RequestMethod.DELETE, null, false, '删除失败');
    if (resp.code === 404) {
      return null; // 幂等（对齐 object_store：不存在时 delete 返回 Ok）
    }
    if (resp.code >= 400) {
      throw mapStatusError('删除失败', resp.code, s3ErrorCodeOf(resp.bodyText), resp.bodyText);
    }
    return null;
  }

  /** HEAD 单对象：404 → null。 */
  async head(params: Record<string, Object>): Promise<Object | null> {
    const key = this.keyOf(params);
    const cfg = parseCfg(params['cfg']);
    const ep = parseEndpoint(cfg.endpoint);
    ensureScheme(ep, cfg.endpoint);
    return await this.headObject(cfg, ep, key, '查询对象失败');
  }

  // ---- 内部 -------------------------------------------------------------------

  private async headObject(cfg: S3Config, ep: EndpointParts, key: string,
    ctx: string): Promise<Object | null> {
    const extra = this.tokenExtra(cfg);
    const target = buildTarget(cfg, ep, key, []);
    const headers = await this.signedHeadersFor(cfg, 'HEAD', target, null, extra);
    const resp = await doRequest(target, headers, http.RequestMethod.HEAD, null, false, ctx);
    if (resp.code === 404) {
      return null;
    }
    if (resp.code >= 400) {
      throw mapStatusError(ctx, resp.code, s3ErrorCodeOf(resp.bodyText), resp.bodyText);
    }
    const sizeHeader = headerOf(resp.headers, 'content-length');
    const size = sizeHeader !== null ? parseInt(sizeHeader, 10) : 0;
    const etag = stripEtagQuotes(headerOf(resp.headers, 'etag'));
    const lm = toIsoTime(headerOf(resp.headers, 'last-modified'));
    return s3ObjectOf(key, size, etag, lm);
  }

  private tokenExtra(cfg: S3Config): Record<string, string> {
    const extra: Record<string, string> = {};
    if (cfg.sessionToken.length > 0) {
      extra['x-amz-security-token'] = cfg.sessionToken;
    }
    return extra;
  }

  private async signedHeadersFor(cfg: S3Config, method: string, target: ReqTarget,
    payload: Uint8Array | null, extra: Record<string, string>): Promise<Record<string, Object>> {
    return await signHeaders(cfg, method, target, payload, extra);
  }

  private keyOf(params: Record<string, Object>): string {
    const key = strOf(params['key']) ?? '';
    const err = validateKeyError(key);
    if (err !== null) {
      throw new BridgeError('E_ARGS', err);
    }
    return key;
  }
}
