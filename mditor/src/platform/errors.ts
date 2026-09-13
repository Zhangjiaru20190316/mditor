// 统一的「当前平台不支持」错误（鸿蒙迁移 v4.11）。
//
// AI / 多窗口 / watch 等 MVP 明确不做的能力抛这个；调用方 catch 后按
// message 提示用户。错误码对齐 ArkTS 桥（Bridge.ets）的 UNSUPPORTED。

export class UnsupportedError extends Error {
  /** 桥侧错误码（E_UNSUPPORTED / E_PERMISSION…），无桥时为 undefined。 */
  readonly code?: string;

  constructor(message = "当前平台暂不支持该功能", code?: string) {
    super(message);
    this.name = "UnsupportedError";
    this.code = code;
  }
}

/** 从桥响应的 error 载荷还原 Error（保留 code，供 E_PERMISSION 引导重选）。 */
export function bridgeErrorToError(error: {
  code: string;
  message: string;
}): Error {
  if (error?.code === "E_UNSUPPORTED" || error?.code === "UNSUPPORTED") {
    return new UnsupportedError(error.message || "当前平台暂不支持该功能", error.code);
  }
  const err = new Error(error?.message || String(error));
  (err as Error & { code?: string }).code = error?.code;
  return err;
}
