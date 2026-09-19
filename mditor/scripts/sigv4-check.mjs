// SigV4 纯函数核验（P3）——与 harmony/entry/src/main/ets/net/S3Bridge.ets 的
// 纯函数逐行镜像，对 AWS SDK v3 官方签名器 @smithy/signature-v4 比对。
//
// 用法：node scripts/sigv4-check.mjs
// 两组断言：
//   1. 编码矩阵（uriEncode / uriEncodePath / canonicalQuery / 寻址矩阵）——自建锚定；
//   2. 与 SignatureV4（AWS SDK v3 在用签名器）对同一请求的完整 Authorization
//      比对（固定 signingDate，确定性）。覆盖：中文/空格/`+` key、ListObjectsV2
//      查询集、PUT 载荷 + x-amz-meta-*、session token、非默认端口 host。
// 镜像纪律：S3Bridge.ets 的纯函数改动必须同步本文件（反之亦然）。

import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";
import { createHash, createHmac } from "node:crypto";

// ---- 镜像：S3Bridge.ets 纯函数（保持逐行同构，改动须双向同步） ----------------

function uriEncode(s, keepSlash) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    let ch = s[i];
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const c2 = s.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        ch = s.substr(i, 2);
        i += 1;
      }
    }
    const unreserved =
      (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
      c === 45 || c === 46 || c === 95 || c === 126;
    if (unreserved) out += ch;
    else if (c === 47 && keepSlash) out += "/";
    else {
      const enc = encodeURIComponent(ch);
      for (const ec of enc) {
        if (ec === "!" || ec === "'" || ec === "(" || ec === ")" || ec === "*") {
          out += `%${ec.charCodeAt(0).toString(16).toUpperCase()}`;
        } else out += ec;
      }
    }
    i += 1;
  }
  return out;
}

const uriEncodePath = (p) => p.split("/").map((seg) => uriEncode(seg, true)).join("/");

function amzDateOf(d) {
  const p2 = (n) => (n < 10 ? `0${n}` : `${n}`);
  return (
    `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}` +
    `T${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`
  );
}

function canonicalQueryOf(pairs) {
  const encoded = pairs.map((p) => ({ k: uriEncode(p.k, false), v: uriEncode(p.v, false) }));
  encoded.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  return encoded.map((p) => `${p.k}=${p.v}`).join("&");
}

function canonicalRequestOf(method, canonicalPath, canonicalQuery, headers, payloadHash) {
  const sorted = headers.slice();
  sorted.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  let headerLines = "";
  const names = [];
  for (const h of sorted) {
    headerLines += `${h.k}:${h.v.trim()}\n`;
    names.push(h.k);
  }
  return `${method}\n${canonicalPath}\n${canonicalQuery}\n${headerLines}\n${names.join(";")}\n${payloadHash}`;
}

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
const utf8 = (s) => Buffer.from(s, "utf8");

/** 签名主链镜像（signHeaders 的纯计算部分；token 附带对齐 S3Bridge 全命令行为）。 */
function mineSign(o) {
  const payloadHash = sha256Hex(o.payload ?? Buffer.alloc(0));
  const headers = [
    { k: "host", v: o.host },
    { k: "x-amz-content-sha256", v: payloadHash },
    { k: "x-amz-date", v: o.amzDate },
  ];
  for (const [k, v] of o.extraHeaders ?? []) headers.push({ k, v });
  if (o.sessionToken && !headers.some((h) => h.k === "x-amz-security-token")) {
    headers.push({ k: "x-amz-security-token", v: o.sessionToken });
  }
  const cr = canonicalRequestOf(
    o.method,
    uriEncodePath(o.rawPath),
    canonicalQueryOf(o.queryPairs ?? []),
    headers,
    payloadHash
  );
  const scope = `${o.amzDate.slice(0, 8)}/${o.region}/s3/aws4_request`;
  const sts = `AWS4-HMAC-SHA256\n${o.amzDate}\n${scope}\n${sha256Hex(utf8(cr))}`;
  const kSigning = hmac(
    hmac(hmac(hmac(utf8(`AWS4${o.sk}`), utf8(o.amzDate.slice(0, 8))), utf8(o.region)), utf8("s3")),
    utf8("aws4_request")
  );
  const sig = createHmac("sha256", kSigning).update(utf8(sts)).digest("hex");
  const names = headers.map((h) => h.k).sort();
  return `AWS4-HMAC-SHA256 Credential=${o.ak}/${scope}, SignedHeaders=${names.join(";")}, Signature=${sig}`;
}

// ---- 断言 ------------------------------------------------------------------

let failed = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) {
    console.log(`  expected: ${JSON.stringify(expected)}`);
    console.log(`  actual:   ${JSON.stringify(actual)}`);
  }
}

// 1) RFC3986 编码矩阵
check("uriEncode 空格", uriEncode("a b", false), "a%20b");
check("uriEncode +", uriEncode("a+b.md", false), "a%2Bb.md");
check("uriEncode !'()*", uriEncode("!'()*", false), "%21%27%28%29%2A");
check("uriEncode ~ 保留", uriEncode("~tilde-", false), "~tilde-");
check("uriEncode 中文", uriEncode("笔记", false), encodeURIComponent("笔记"));
check("uriEncode slash keep", uriEncode("a/b c", true), "a/b%20c");
check("uriEncode slash drop", uriEncode("a/b", false), "a%2Fb");
check("uriEncodePath 逐段", uriEncodePath("mditor/ws/笔记 目录/a+b.md"),
  `mditor/ws/${encodeURIComponent("笔记")}%20${encodeURIComponent("目录")}/a%2Bb.md`);
check("amzDateOf", amzDateOf(new Date(Date.UTC(2013, 4, 24, 0, 0, 0))), "20130524T000000Z");
// 空 payload hash = NIST 定值（S3Bridge.ets sha256Hex 空输入分支的镜像锚：
// cryptoFramework Md.update 拒绝空输入，空 body 请求必须走常量）。
check("sha256Hex 空输入定值", sha256Hex(new Uint8Array(0)),
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
check("canonicalQuery 排序", canonicalQueryOf([
  { k: "list-type", v: "2" },
  { k: "prefix", v: "mditor/笔记" },
  { k: "max-keys", v: "1000" },
  { k: "encoding-type", v: "url" },
  { k: "continuation-token", v: "a/b+c" },
]), `continuation-token=a%2Fb%2Bc&encoding-type=url&list-type=2&max-keys=1000&prefix=mditor%2F${encodeURIComponent("笔记")}`);

// 2) 寻址矩阵（buildTarget 语义镜像）
function mirrorTarget(endpoint, bucket, region, pathStyle, objectPath) {
  let scheme = "https";
  let host = "";
  let port = 443;
  let basePath = "";
  if (endpoint.trim().length > 0) {
    const u = new URL(endpoint.trim());
    scheme = u.protocol.replace(/:$/, "");
    host = u.hostname;
    basePath = u.pathname.replace(/\/+$/, "");
    port = u.port ? parseInt(u.port) : scheme === "http" ? 80 : 443;
  }
  const encKey = uriEncodePath(objectPath);
  let path;
  if (host === "") {
    if (pathStyle) {
      host = `s3.${region}.amazonaws.com`;
      path = `/${uriEncode(bucket, true)}${objectPath ? `/${encKey}` : ""}`;
    } else {
      host = `${bucket}.s3.${region}.amazonaws.com`;
      path = objectPath ? `/${encKey}` : "/";
    }
  } else if (pathStyle) {
    path = `${basePath}/${uriEncode(bucket, true)}${objectPath ? `/${encKey}` : ""}`;
  } else {
    host = `${bucket}.${host}`;
    path = objectPath ? `${basePath}/${encKey}` : basePath || "/";
  }
  const nonDefault = (scheme === "https" && port !== 443) || (scheme === "http" && port !== 80);
  const hostPort = nonDefault ? `${host}:${port}` : host;
  return `${scheme}://${hostPort}${path}`;
}
check("AWS 默认 vhost", mirrorTarget("", "bkt", "us-east-1", false, "a/x.md"),
  "https://bkt.s3.us-east-1.amazonaws.com/a/x.md");
check("AWS 默认 path-style", mirrorTarget("", "bkt", "us-east-1", true, "a/x.md"),
  "https://s3.us-east-1.amazonaws.com/bkt/a/x.md");
check("MinIO path-style 带端口", mirrorTarget("http://127.0.0.1:9000", "bkt", "us-east-1", true, "笔记 a.md"),
  `http://127.0.0.1:9000/bkt/${encodeURIComponent("笔记")}%20a.md`);
check("自定义 endpoint vhost 非默认端口", mirrorTarget("https://s3.example.com:8443/base", "bkt", "r", false, "x"),
  "https://bkt.s3.example.com:8443/base/x");
check("自定义 endpoint vhost 默认端口", mirrorTarget("https://s3.example.com", "bkt", "r", false, ""),
  "https://bkt.s3.example.com/");

// 3) 与 AWS SDK v3 SignatureV4 完整 Authorization 比对（固定签名时间，确定性）
const CREDS = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  sessionToken: "FAKE/TOKEN+abc==",
};
const SIGNING_DATE = new Date(Date.UTC(2026, 8, 14, 1, 2, 3));
const AMZ_DATE = amzDateOf(SIGNING_DATE);
const signer = new SignatureV4({ credentials: CREDS, region: "us-east-1", service: "s3", sha256: Sha256 });

async function compareWithSmithy(name, o) {
  const headers = { host: o.host };
  for (const [k, v] of o.extraHeaders ?? []) headers[k] = v;
  const query = {};
  for (const p of o.queryPairs ?? []) query[p.k] = p.v;
  const req = new HttpRequest({
    method: o.method,
    protocol: "https:",
    hostname: o.host,
    path: o.rawPath,
    query,
    headers,
    body: o.payload ?? Buffer.alloc(0),
  });
  const signed = await signer.sign(req, { signingDate: SIGNING_DATE });
  const mineAuth = mineSign({
    ...o,
    region: "us-east-1",
    ak: CREDS.accessKeyId,
    sk: CREDS.secretAccessKey,
    sessionToken: CREDS.sessionToken,
    amzDate: AMZ_DATE,
  });
  check(`SignatureV4 比对：${name}`, signed.headers.authorization, mineAuth);
}

await compareWithSmithy("GET 桶根（ListObjectsV2 查询集）", {
  method: "GET", host: "bkt.s3.us-east-1.amazonaws.com", rawPath: "/",
  queryPairs: [
    { k: "continuation-token", v: "a/b" },
    { k: "encoding-type", v: "url" },
    { k: "list-type", v: "2" },
    { k: "max-keys", v: "1000" },
    { k: "prefix", v: "笔记" },
  ],
});
await compareWithSmithy("GET 中文+空格+加号 key（path-style 带端口）", {
  method: "GET", host: "127.0.0.1:9000", rawPath: "/bkt/笔记 a+b.md",
});
await compareWithSmithy("PUT 载荷 + x-amz-meta-mtime + token", {
  method: "PUT", host: "bkt.s3.amazonaws.com", rawPath: "/x/y.md",
  payload: Buffer.from("hello 中文 ~!@#"),
  extraHeaders: [["x-amz-meta-mtime", "1726000000000"]],
});
await compareWithSmithy("HEAD 非默认端口 vhost", {
  method: "HEAD", host: "bkt.example.com:8443", rawPath: "/k",
});
await compareWithSmithy("DELETE 多级路径", {
  method: "DELETE", host: "s3.us-east-1.amazonaws.com", rawPath: "/bkt/deep/nested/file.md",
});

console.log(failed === 0 ? "\n全部核验通过 ✅（含 AWS SDK v3 签名器比对）" : `\n${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
