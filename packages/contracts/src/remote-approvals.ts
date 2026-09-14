import { z } from "zod";

const Value = z.union([z.string().max(10000), z.number().finite(), z.boolean()]);
export const RemoteApprovalContentSchema = z.record(
  z.string().max(200),
  z.union([Value, z.array(z.string().max(10000)).max(100)]),
);
export const RemoteApprovalSchema = z.object({
  token: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  schema: z.record(z.string(), z.unknown()).optional(),
  title: z.string(),
  details: z.string(),
  url: z.string().optional(),
  blockedReason: z.string().optional(),
  fields: z.array(
    z.object({
      name: z.string(),
      label: z.string(),
      description: z.string(),
      required: z.boolean(),
      type: z.enum(["string", "number", "integer", "boolean", "array"]),
      options: z.array(Value).optional(),
      optionLabels: z.array(z.string()).optional(),
      secret: z.boolean(),
    }),
  ),
  choices: z.array(z.object({ id: z.string(), label: z.string(), detail: z.string().optional() })),
});
export type RemoteApproval = z.infer<typeof RemoteApprovalSchema>;
export type RemoteApprovalContent = z.infer<typeof RemoteApprovalContentSchema>;
const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const text = (v: unknown) => (typeof v === "string" ? v : "");
const json = (v: unknown) => JSON.stringify(v, null, 2) ?? "";
const decisionLabels: Record<string, string> = {
  accept: "允许一次",
  acceptForSession: "本次会话允许",
  decline: "拒绝",
  cancel: "取消",
};
function externalUrl(value: unknown) {
  try {
    const u = new URL(text(value));
    return u.protocol === "https:" && !u.username && !u.password ? u.href : undefined;
  } catch {
    return undefined;
  }
}

// A bounded subset of MCP's flat JSON Schema forms. Unknown constraints fail
// closed rather than being silently dropped by the mobile renderer/validator.
function formFields(raw: unknown): RemoteApproval["fields"] | null {
  const schema = object(raw);
  if (
    schema.type !== "object" ||
    !schema.properties ||
    typeof schema.properties !== "object" ||
    Array.isArray(schema.properties)
  )
    return null;
  const rootKeys = [
    "type",
    "properties",
    "required",
    "title",
    "description",
    "additionalProperties",
    "$schema",
  ];
  if (
    Object.keys(schema).some((k) => !rootKeys.includes(k)) ||
    (schema.additionalProperties != null && typeof schema.additionalProperties !== "boolean")
  )
    return null;
  const properties = object(schema.properties);
  const required = schema.required ?? [];
  if (
    !Array.isArray(required) ||
    required.some((k) => typeof k !== "string" || !Object.hasOwn(properties, k))
  )
    return null;
  if (Object.keys(properties).length > 50) return null;
  const fields: RemoteApproval["fields"] = [];
  for (const [name, rawField] of Object.entries(properties)) {
    if (["__proto__", "constructor", "prototype"].includes(name) || name.length > 200) return null;
    const f = object(rawField);
    const keys = [
      "type",
      "title",
      "description",
      "default",
      "enum",
      "enumNames",
      "minLength",
      "maxLength",
      "minimum",
      "maximum",
      "format",
      "items",
      "minItems",
      "maxItems",
      "uniqueItems",
    ];
    if (Object.keys(f).some((k) => !keys.includes(k))) return null;
    if (!["string", "number", "integer", "boolean", "array"].includes(text(f.type))) return null;
    if (
      f.format != null &&
      !["email", "uri", "date", "date-time", "password"].includes(text(f.format))
    )
      return null;
    for (const key of ["minLength", "maxLength", "minItems", "maxItems", "minimum", "maximum"]) {
      if (f[key] != null && (typeof f[key] !== "number" || !Number.isFinite(f[key]))) return null;
    }
    let options = f.enum;
    if (f.type === "array") {
      if (f.enum != null) return null;
      const items = object(f.items);
      if (items.type !== "string" || Object.keys(items).some((k) => !["type", "enum"].includes(k)))
        return null;
      options = items.enum;
      if (f.uniqueItems != null && typeof f.uniqueItems !== "boolean") return null;
    }
    if (
      options != null &&
      (!Array.isArray(options) ||
        options.length > 100 ||
        options.some((v) => !Value.safeParse(v).success))
    )
      return null;
    if (
      f.enumNames != null &&
      (!Array.isArray(f.enumNames) ||
        f.enumNames.some((v) => typeof v !== "string") ||
        f.enumNames.length !== (options as unknown[] | undefined)?.length)
    )
      return null;
    fields.push({
      name,
      label: text(f.title) || name,
      description: [
        text(f.description),
        ...[
          "minLength",
          "maxLength",
          "minimum",
          "maximum",
          "format",
          "minItems",
          "maxItems",
          "uniqueItems",
        ]
          .filter((k) => f[k] != null)
          .map(
            (k) =>
              `${({ minLength: "最少字符", maxLength: "最多字符", minimum: "最小值", maximum: "最大值", format: "格式", minItems: "最少项数", maxItems: "最多项数", uniqueItems: "不允许重复" } as Record<string, string>)[k]}：${String(f[k])}`,
          ),
      ]
        .filter(Boolean)
        .join("；"),
      required: required.includes(name),
      type: f.type as RemoteApproval["fields"][number]["type"],
      secret: f.format === "password",
      ...(options ? { options: options as (string | number | boolean)[] } : {}),
      ...(f.enumNames ? { optionLabels: f.enumNames as string[] } : {}),
    });
  }
  return fields;
}

export function describeRemoteApproval(method: string, raw: unknown): RemoteApproval | null {
  const p = object(raw);
  if (
    ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(method)
  ) {
    const decisions = Array.isArray(p.availableDecisions)
      ? p.availableDecisions
      : ["accept", "acceptForSession", "decline", "cancel"];
    const choices = decisions.flatMap((d, index) => {
      if (typeof d === "string")
        return decisionLabels[d] ? [{ id: `decision-${index}`, label: decisionLabels[d] }] : [];
      const keys = Object.keys(object(d));
      if (
        keys.length !== 1 ||
        !["acceptWithExecpolicyAmendment", "applyNetworkPolicyAmendment"].includes(keys[0]!)
      )
        return [];
      return [
        {
          id: `decision-${index}`,
          label:
            keys[0] === "acceptWithExecpolicyAmendment" ? "允许并保存命令规则" : "应用网络规则",
          detail: json(d),
        },
      ];
    });
    return {
      title: method.includes("commandExecution") ? "允许执行命令？" : "允许修改文件？",
      details: [
        text(p.reason),
        p.cwd ? `工作目录：${text(p.cwd)}` : "",
        Array.isArray(p.command) ? p.command.join(" ") : text(p.command),
        p.grantRoot ? `授权目录：${text(p.grantRoot)}` : "",
        ...[
          "networkApprovalContext",
          "additionalPermissions",
          "proposedExecpolicyAmendment",
          "proposedNetworkPolicyAmendments",
          "commandActions",
        ]
          .filter((key) => p[key] != null)
          .map((key) => `${key}：\n${json(p[key])}`),
      ]
        .filter(Boolean)
        .join("\n"),
      fields: [],
      choices,
      ...(choices.length ? {} : { blockedReason: "此请求的审批选项尚不受支持，请在 Mac 处理。" }),
    };
  }
  if (method !== "mcpServer/elicitation/request") return null;
  const meta = object(p._meta);
  const details = [
    text(p.message),
    p.serverName ? `来源：${text(p.serverName)}` : "",
    text(meta.connector_name),
    text(meta.tool_name),
    meta.tool_params ? json(meta.tool_params) : "",
    meta.tool_params_display ? json(meta.tool_params_display) : "",
    meta.risk_level ? `风险：${text(meta.risk_level)}` : "",
    text(meta.subtitle),
  ]
    .filter(Boolean)
    .join("\n\n");
  const view: RemoteApproval = {
    title: "授权与确认",
    details,
    fields: [],
    choices: [
      { id: "decline", label: "拒绝" },
      { id: "cancel", label: "取消" },
    ],
  };
  if (p.mode === "url") {
    const url = externalUrl(p.url);
    return {
      ...view,
      title: "需要在授权网站完成",
      ...(url ? { url } : {}),
      blockedReason: url
        ? "请打开授权网站完成登录，再刷新查看状态。Remote 不会代替网站确认授权成功。"
        : "未提供可安全打开的 HTTPS 授权地址，请在 Mac 处理。",
    };
  }
  if (p.mode !== "form")
    return {
      ...view,
      blockedReason: `此表单类型（${text(p.mode) || "未知"}）尚不受支持，请在 Mac 处理。`,
    };
  const fields = formFields(p.requestedSchema);
  if (!fields)
    return {
      ...view,
      blockedReason: "此表单包含当前无法完整展示或校验的字段约束，请在 Mac 处理。",
    };
  if (meta.approveDisabled === true || meta.approve_disabled === true)
    return { ...view, blockedReason: "Desktop 禁止批准此请求，请在 Mac 查看原因。" };
  const persist = Array.isArray(meta.persist) ? meta.persist : meta.persist ? [meta.persist] : [];
  const bound =
    meta.executionBound === true ||
    meta.execution_bound === true ||
    /^sites\.execute_database_/.test(text(meta.tool_name)) ||
    Object.hasOwn(object(meta.tool_params), "plan_token");
  return {
    ...view,
    fields,
    schema: object(p.requestedSchema),
    choices: [
      { id: "accept", label: fields.length ? "确认并提交" : "允许一次" },
      ...(!bound && persist.includes("session") ? [{ id: "session", label: "本次会话允许" }] : []),
      ...(!bound && persist.includes("always") ? [{ id: "always", label: "始终允许" }] : []),
      ...view.choices,
    ],
  };
}

export function validateRemoteApprovalContent(
  raw: unknown,
  content: unknown,
): RemoteApprovalContent {
  const fields = formFields(raw);
  if (!fields) throw new Error("此表单请在 Mac 处理");
  const parsed = RemoteApprovalContentSchema.parse(content);
  const properties = object(object(raw).properties);
  if (Object.keys(parsed).some((k) => !Object.hasOwn(properties, k)))
    throw new Error("包含未知字段");
  for (const field of fields) {
    const f = object(properties[field.name]);
    const value = Object.hasOwn(parsed, field.name) ? parsed[field.name] : undefined;
    const fail = () => {
      throw new Error(`请检查“${field.label}”的值和约束`);
    };
    if (value === undefined) {
      if (field.required) fail();
      continue;
    }
    if (field.type === "array") {
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) fail();
      const values = value as string[];
      if (field.options && values.some((v) => !field.options!.includes(v))) fail();
      if (typeof f.minItems === "number" && values.length < f.minItems) fail();
      if (typeof f.maxItems === "number" && values.length > f.maxItems) fail();
      if (f.uniqueItems === true && new Set(values).size !== values.length) fail();
    } else {
      const type = field.type === "integer" ? "number" : field.type;
      if (typeof value !== type || (field.type === "integer" && !Number.isInteger(value))) fail();
      if (field.options && !field.options.includes(value as string | number | boolean)) fail();
      if (typeof value === "number") {
        if (typeof f.minimum === "number" && value < f.minimum) fail();
        if (typeof f.maximum === "number" && value > f.maximum) fail();
      }
      if (typeof value === "string") {
        if (typeof f.minLength === "number" && [...value].length < f.minLength) fail();
        if (typeof f.maxLength === "number" && [...value].length > f.maxLength) fail();
        if (f.format === "email" && !z.email().safeParse(value).success) fail();
        if (f.format === "uri") {
          try {
            new URL(value);
          } catch {
            fail();
          }
        }
        if (f.format === "date" && !z.iso.date().safeParse(value).success) fail();
        if (f.format === "date-time" && !z.iso.datetime({ offset: true }).safeParse(value).success)
          fail();
      }
    }
  }
  return parsed;
}

export function buildRemoteApprovalResponse(
  method: string,
  raw: unknown,
  choice: string,
  content: unknown,
) {
  const view = describeRemoteApproval(method, raw);
  if (!view?.choices.some((c) => c.id === choice)) throw new Error("当前请求不支持此决定");
  const p = object(raw);
  if (method !== "mcpServer/elicitation/request") {
    const decisions = Array.isArray(p.availableDecisions)
      ? p.availableDecisions
      : ["accept", "acceptForSession", "decline", "cancel"];
    return decisions[Number(choice.slice("decision-".length))];
  }
  if (choice === "decline" || choice === "cancel")
    return { action: choice, content: null, _meta: null };
  return {
    action: "accept",
    content: validateRemoteApprovalContent(p.requestedSchema, content),
    _meta: choice === "accept" ? null : { persist: choice },
  };
}
