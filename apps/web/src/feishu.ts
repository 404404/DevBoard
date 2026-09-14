import type { FeishuJsapiConfig } from "@lark-taskboard/contracts";
interface FeishuAuthCodeResult {
  readonly code?: string;
}

export interface FeishuClient {
  chooseMedia?(options: {
    mediaType: ["image", "video"];
    sourceType: ["album"];
    count: number;
    sizeType: ["original"];
    success(result: unknown): void;
    fail(error: unknown): void;
  }): void;
  getFileSystemManager?(): {
    readFile(options: {
      filePath: string;
      encoding: "base64";
      position: number;
      length: number;
      success(result: { data: string }): void;
      fail(error: unknown): void;
    }): void;
  };
  requestAuthCode(options: {
    appId: string;
    success(result: FeishuAuthCodeResult): void;
    fail(error: unknown): void;
  }): void;
}

interface FeishuH5Sdk {
  config?(
    options: FeishuJsapiConfig & {
      onSuccess(): void;
      onFail(error: unknown): void;
    },
  ): void;
  ready(callback: () => void): void;
}

declare global {
  interface Window {
    h5sdk?: FeishuH5Sdk;
    tt?: FeishuClient;
  }
}

const feishuH5SdkUrl = "https://lf-scm-cn.feishucdn.com/lark/op/h5-js-sdk-1.5.48.js";

function requestCode(appId: string, client: FeishuClient, h5sdk: FeishuH5Sdk): Promise<string> {
  return new Promise((resolve, reject) => {
    h5sdk.ready(() => {
      client.requestAuthCode({
        appId,
        success(result) {
          if (!result.code) {
            reject(new Error("飞书未返回有效授权码"));
            return;
          }
          resolve(result.code);
        },
        fail() {
          reject(new Error("飞书身份授权失败，请重试"));
        },
      });
    });
  });
}

export function loadFeishuH5Sdk(): Promise<{
  readonly client: FeishuClient;
  readonly h5sdk: FeishuH5Sdk;
}> {
  if (window.tt && window.h5sdk) return Promise.resolve({ client: window.tt, h5sdk: window.h5sdk });
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.async = true;
    script.src = feishuH5SdkUrl;
    script.onload = () => {
      const client = window.tt;
      const h5sdk = window.h5sdk;
      if (!client || !h5sdk) {
        reject(new Error("请在飞书客户端内打开此工作台后重试"));
        return;
      }
      resolve({ client, h5sdk });
    };
    script.onerror = () => reject(new Error("飞书 H5 SDK 加载失败，请重试"));
    document.head.appendChild(script);
  });
}

export function requestFeishuAuthCode(appId: string): Promise<string> {
  const client = window.tt;
  const h5sdk = window.h5sdk;
  if (client && h5sdk) return requestCode(appId, client, h5sdk);

  return loadFeishuH5Sdk().then((loaded) => requestCode(appId, loaded.client, loaded.h5sdk));
}
